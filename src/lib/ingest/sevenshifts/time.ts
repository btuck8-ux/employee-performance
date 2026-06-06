/**
 * 7shifts time punches -> EPD `time_entries` (entry_type 'worked').
 *
 * ACTUALS ONLY (hard fence): we ingest clock-in/out punches, never scheduled
 * shifts. Punches arrive in UTC; we project each into the store's local
 * clock-of-day so in_time/out_time line up with sales_records.transaction_at
 * for the presence-based tip math (migration 016).
 *
 * Multiple punches for the same person on the same local business date collapse
 * to one row: earliest-in / latest-out, hours + pay summed — matching the CSV
 * importer's one-row-per-(employee,date) collapse.
 *
 * Employees resolve by (seven_shifts_user_id + location_id), NOT by name.
 * Unmatched 7shifts users are surfaced in the run detail, never dropped.
 */

import { getAll } from "./client";
import { utcToLocalWallClock, timezoneForLocationCode } from "./tz";
import { distinctQuarters, runRecomputeJobs, type RecomputeJob } from "./recompute";
import type { AdminClient, LocationCrosswalk } from "./crosswalk";
import type { RunOutcome } from "./runs";

interface TimePunchBreak {
  paid?: boolean;
  in?: string | null;
  out?: string | null;
}

interface TimePunch {
  id: number;
  user_id: number;
  location_id: number;
  clocked_in: string | null;
  clocked_out: string | null;
  hourly_wage?: number | null; // cents (calculated)
  tips?: number | null; // cents
  deleted?: boolean;
  breaks?: TimePunchBreak[] | null;
}

interface CollapsedEntry {
  employee_id: string;
  entry_date: string;
  in_time: string;
  out_time: string | null;
  wage: number | null;
  hours: number;
  pay: number;
}

const MS_PER_HOUR = 1000 * 60 * 60;

/** Worked hours for a punch = (out - in) minus unpaid break durations, in hours. */
function workedHours(punch: TimePunch): number {
  if (!punch.clocked_in || !punch.clocked_out) return 0;
  const inMs = new Date(punch.clocked_in).getTime();
  const outMs = new Date(punch.clocked_out).getTime();
  if (Number.isNaN(inMs) || Number.isNaN(outMs) || outMs <= inMs) return 0;
  let ms = outMs - inMs;
  for (const b of punch.breaks ?? []) {
    if (b.paid) continue; // paid breaks stay in worked time
    if (!b.in || !b.out) continue;
    const bIn = new Date(b.in).getTime();
    const bOut = new Date(b.out).getTime();
    if (Number.isNaN(bIn) || Number.isNaN(bOut) || bOut <= bIn) continue;
    ms -= bOut - bIn;
  }
  return Math.max(0, ms / MS_PER_HOUR);
}

export async function ingestTimePunches(
  supabase: AdminClient,
  loc: LocationCrosswalk,
  windowStart: string,
  windowEnd: string
): Promise<RunOutcome> {
  const base: RunOutcome = {
    source: "7shifts_time",
    location_id: loc.id,
    location_code: loc.location_code,
    status: "running",
    rows_in: 0,
    rows_upserted: 0,
    rows_skipped: 0,
    detail: null,
    error_text: null,
    window_start: windowStart,
    window_end: windowEnd,
  };

  try {
    const tz = timezoneForLocationCode(loc.location_code);

    // Map 7shifts user_id -> EPD employee_id for THIS location.
    const { data: emps, error: empErr } = await supabase
      .from("employees")
      .select("id, seven_shifts_user_id")
      .eq("location_id", loc.id)
      .not("seven_shifts_user_id", "is", null);
    if (empErr) throw new Error(`employee lookup: ${empErr.message}`);
    const userToEmployee = new Map<number, string>();
    for (const e of emps ?? []) {
      userToEmployee.set(Number(e.seven_shifts_user_id), e.id as string);
    }

    // Pull punches modified since the window start (captures both new punches
    // and edits to recent ones). modified_since is UTC ISO8601.
    const punches = await getAll<TimePunch>(loc.company_id, "time_punches", {
      location_id: loc.seven_shifts_location_id,
      modified_since: windowStart,
      limit: 100,
    });
    base.rows_in = punches.length;

    const unmatchedUserIds = new Set<number>();
    let skippedOpen = 0;
    let skippedDeleted = 0;

    // Collapse to one row per (employee, local business date).
    const collapsed = new Map<string, CollapsedEntry>();
    for (const p of punches) {
      if (p.deleted) {
        skippedDeleted += 1;
        continue;
      }
      const employee_id = userToEmployee.get(Number(p.user_id));
      if (!employee_id) {
        unmatchedUserIds.add(Number(p.user_id));
        continue;
      }
      const local = utcToLocalWallClock(p.clocked_in, tz);
      if (!local) {
        skippedOpen += 1;
        continue;
      }
      if (!p.clocked_out) {
        // Open / in-progress punch — not a finalized actual yet.
        skippedOpen += 1;
        continue;
      }
      const outLocal = utcToLocalWallClock(p.clocked_out, tz);
      const hours = workedHours(p);
      const wage =
        p.hourly_wage != null && p.hourly_wage > 0 ? p.hourly_wage / 100 : null;
      const pay = wage != null ? wage * hours : 0;

      const key = `${employee_id}|${local.date}`;
      const existing = collapsed.get(key);
      if (!existing) {
        collapsed.set(key, {
          employee_id,
          entry_date: local.date,
          in_time: local.time,
          out_time: outLocal?.time ?? null,
          wage,
          hours,
          pay,
        });
      } else {
        if (local.time < existing.in_time) existing.in_time = local.time;
        if (outLocal?.time && (!existing.out_time || outLocal.time > existing.out_time)) {
          existing.out_time = outLocal.time;
        }
        existing.hours += hours;
        existing.pay += pay;
        if (existing.wage == null && wage != null) existing.wage = wage;
      }
    }

    // Build upsert payloads in the exact time_entries shape the CSV path uses.
    const payloads = Array.from(collapsed.values()).map((c) => ({
      employee_id: c.employee_id,
      location_id: loc.id,
      entry_date: c.entry_date,
      entry_type: "worked" as const,
      in_time: c.in_time,
      out_time: c.out_time,
      role: null as string | null,
      wage: c.wage,
      regular_hours: c.hours,
      ot_hours: 0,
      double_ot_hours: 0,
      holiday_hours: 0,
      regular_pay: c.pay,
      ot_pay: 0,
      double_ot_pay: 0,
      holiday_pay: 0,
      total_pay: c.pay,
    }));

    let upserted = 0;
    const UPSERT_BATCH = 500;
    for (let i = 0; i < payloads.length; i += UPSERT_BATCH) {
      const batch = payloads.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase
        .from("time_entries")
        .upsert(batch, { onConflict: "employee_id,entry_date,entry_type" });
      if (error) throw new Error(`time_entries upsert: ${error.message}`);
      upserted += batch.length;
    }

    // Recompute (employee × affected quarter) for the touched employees only —
    // mirrors the time CSV importer (no team-tip rebuild on the time path).
    const quarters = distinctQuarters(payloads.map((p) => p.entry_date));
    const touchedEmployees = new Set(payloads.map((p) => p.employee_id));
    const jobs: RecomputeJob[] = [];
    for (const employee_id of touchedEmployees) {
      for (const q of quarters) jobs.push({ employee_id, year: q.year, quarter: q.quarter });
    }
    const rc = await runRecomputeJobs(supabase, loc.id, jobs);

    if (payloads.length > 0) {
      await supabase
        .from("locations")
        .update({ last_data_uploaded_at: new Date().toISOString() })
        .eq("id", loc.id);
    }

    base.rows_upserted = upserted;
    base.rows_skipped = skippedOpen + skippedDeleted + unmatchedUserIds.size;
    base.detail = {
      punches_fetched: punches.length,
      entries_upserted: upserted,
      employees_touched: touchedEmployees.size,
      quarters_recomputed: quarters.length,
      records_recomputed: rc.recomputed,
      skipped_open_punches: skippedOpen,
      skipped_deleted: skippedDeleted,
      unmatched_seven_shifts_user_ids: Array.from(unmatchedUserIds),
      recompute_failures: rc.failures.slice(0, 20),
    };
    base.status = upserted > 0 ? "success" : "empty";
    if (rc.failures.length > 0) {
      base.error_text = `${rc.failures.length} recompute failure(s); see detail`;
    }
    return base;
  } catch (err) {
    base.status = "error";
    base.error_text = err instanceof Error ? err.message : String(err);
    return base;
  }
}
