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

import { getAllWithMeta } from "./client";
import { rolesForCompany } from "./roles";
import { utcToLocalWallClock, timezoneForLocationCode } from "./tz";
import { distinctQuarters, runRecomputeJobs, type RecomputeJob } from "./recompute";
import type { AdminClient, LocationCrosswalk } from "./crosswalk";
import type { RunOutcome } from "./runs";

interface TimePunchBreak {
  paid?: boolean;
  in?: string | null;
  out?: string | null;
}

export interface TimePunch {
  id: number;
  user_id: number;
  location_id: number;
  role_id?: number | null;
  clocked_in: string | null;
  clocked_out: string | null;
  hourly_wage?: number | null; // cents (calculated)
  tips?: number | null; // cents
  deleted?: boolean;
  breaks?: TimePunchBreak[] | null;
}

/** Per-role accumulation within one (employee, day) — for the dominant-role pick. */
interface RoleAccum {
  hours: number;
  /** Earliest clocked_in (UTC ISO) under this role — the tie-breaker. */
  earliestIn: string;
}

export interface CollapsedEntry {
  employee_id: string;
  entry_date: string;
  in_time: string;
  out_time: string | null;
  wage: number | null;
  hours: number;
  pay: number;
  /**
   * The day's dominant 7shifts role_id: a person can punch under two roles in
   * one day; keep the role with the most worked hours, ties breaking toward
   * the earliest punch. Null when no punch that day carried a role_id.
   */
  role_id: number | null;
  /** Distinct role_ids seen that day (>1 = a multi-role day, counted in detail). */
  role_count: number;
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

export interface CollapseOutcome {
  entries: CollapsedEntry[];
  unmatchedUserIds: number[];
  skippedOpen: number;
  skippedDeleted: number;
  /** Days where one person punched under more than one role. */
  multiRoleDays: number;
}

/**
 * Collapse raw punches to one entry per (employee, local business date) —
 * earliest-in / latest-out, hours + pay summed, dominant role_id resolved.
 * Shared verbatim by the nightly ingest and the role backfill so the two can
 * never disagree about which punch wins a day.
 */
export function collapsePunches(
  punches: TimePunch[],
  userToEmployee: Map<number, string>,
  tz: string
): CollapseOutcome {
  const unmatchedUserIds = new Set<number>();
  let skippedOpen = 0;
  let skippedDeleted = 0;

  const collapsed = new Map<string, CollapsedEntry>();
  const roleAccums = new Map<string, Map<number, RoleAccum>>();

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
        role_id: null,
        role_count: 0,
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

    if (p.role_id != null && p.clocked_in) {
      let accums = roleAccums.get(key);
      if (!accums) {
        accums = new Map();
        roleAccums.set(key, accums);
      }
      const roleId = Number(p.role_id);
      const acc = accums.get(roleId);
      if (!acc) {
        accums.set(roleId, { hours, earliestIn: p.clocked_in });
      } else {
        acc.hours += hours;
        if (p.clocked_in < acc.earliestIn) acc.earliestIn = p.clocked_in;
      }
    }
  }

  // Resolve each day's dominant role: most worked hours, ties toward the
  // earliest punch.
  let multiRoleDays = 0;
  for (const [key, entry] of collapsed) {
    const accums = roleAccums.get(key);
    if (!accums || accums.size === 0) continue;
    entry.role_count = accums.size;
    if (accums.size > 1) multiRoleDays += 1;
    let bestId: number | null = null;
    let best: RoleAccum | null = null;
    for (const [roleId, acc] of accums) {
      if (
        best === null ||
        acc.hours > best.hours ||
        (acc.hours === best.hours && acc.earliestIn < best.earliestIn)
      ) {
        best = acc;
        bestId = roleId;
      }
    }
    entry.role_id = bestId;
  }

  return {
    entries: Array.from(collapsed.values()),
    unmatchedUserIds: Array.from(unmatchedUserIds),
    skippedOpen,
    skippedDeleted,
    multiRoleDays,
  };
}

/** Map 7shifts user_id -> EPD employee_id for one location. */
export async function employeeMapForLocation(
  supabase: AdminClient,
  locationId: string
): Promise<Map<number, string>> {
  const { data, error } = await supabase
    .from("employees")
    .select("id, seven_shifts_user_id")
    .eq("location_id", locationId)
    .not("seven_shifts_user_id", "is", null);
  if (error) throw new Error(`employee lookup: ${error.message}`);
  const userToEmployee = new Map<number, string>();
  for (const e of data ?? []) {
    userToEmployee.set(Number(e.seven_shifts_user_id), e.id as string);
  }
  return userToEmployee;
}

export async function ingestTimePunches(
  supabase: AdminClient,
  loc: LocationCrosswalk,
  windowStart: string,
  windowEnd: string,
  opts?: {
    /**
     * Inclusive entry-DATE bound (YYYY-MM-DD), applied to the collapsed
     * punches after fetch and before the recompute quarter set is derived.
     * windowStart/windowEnd bound MODIFICATION time (the 7shifts fetch);
     * this bounds WHEN THE WORK HAPPENED — the two are different axes, and
     * conflating them is how one intended-for-Q2 backfill fanned across
     * four quarters (frozen-quarter spec 2026-08-25 §2). A punch worked in
     * October but edited in April comes back under a spring modified_since;
     * only an entry-date bound can express "Q2 only".
     */
    entryWindow?: { from?: string; to?: string };
  }
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

    const userToEmployee = await employeeMapForLocation(supabase, loc.id);

    // Resolve role_id -> role name. If the lookup fails, do NOT fall back to
    // writing nulls: the upsert on (employee, date, type) would overwrite roles
    // already in the DB — the exact regression this fix repairs. Instead the
    // payloads omit `role` entirely (PostgREST leaves absent columns untouched
    // on conflict) and the failure is surfaced in the run detail.
    let roleNames: Map<number, string> | null = null;
    let rolesLookupError: string | null = null;
    try {
      roleNames = await rolesForCompany(loc.company_id);
    } catch (err) {
      rolesLookupError = err instanceof Error ? err.message : String(err);
    }

    // Pull punches modified since the window start (captures both new punches
    // and edits to recent ones). modified_since is UTC ISO8601.
    //
    // truncated comes from the client's cursor state, never a row count — a
    // page can return fewer than `limit` rows, so counting cannot detect an
    // unconsumed cursor. This ingest derives a recompute quarter set from
    // what it fetched, so a silently truncated pull produces exactly the
    // shape the Q2 sprint keeps finding: missing rows reading as absent
    // work (Q2 punch-recovery spec 2026-08-25 §6). Writing the punches is
    // safe; recomputing attendance from a partial fetch is not — same
    // reasoning shifts.ts applies to tombstoning.
    const { data: punches, truncated } = await getAllWithMeta<TimePunch>(
      loc.company_id,
      "time_punches",
      {
        location_id: loc.seven_shifts_location_id,
        modified_since: windowStart,
        limit: 100,
      }
    );
    base.rows_in = punches.length;

    const collapse = collapsePunches(punches, userToEmployee, tz);

    // Entry-date bound (§2): the fetch is modification-time; the WRITE and
    // the recompute quarter set are entry-date. Filter before either.
    const entryWindow = opts?.entryWindow;
    const boundedEntries = entryWindow
      ? collapse.entries.filter(
          (c) =>
            (!entryWindow.from || c.entry_date >= entryWindow.from) &&
            (!entryWindow.to || c.entry_date <= entryWindow.to)
        )
      : collapse.entries;
    const entriesOutsideEntryWindow = collapse.entries.length - boundedEntries.length;

    // Build upsert payloads in the exact time_entries shape the CSV path uses.
    const unmappedRoleIds = new Set<number>();
    const payloads = boundedEntries.map((c) => {
      const payload: Record<string, unknown> = {
        employee_id: c.employee_id,
        location_id: loc.id,
        entry_date: c.entry_date,
        entry_type: "worked" as const,
        in_time: c.in_time,
        out_time: c.out_time,
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
      };
      if (roleNames) {
        const role = c.role_id != null ? roleNames.get(c.role_id) ?? null : null;
        if (c.role_id != null && role === null) unmappedRoleIds.add(c.role_id);
        payload.role = role;
      }
      return payload;
    });

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
    // Derived from the BOUNDED entries: the recompute set must never reach
    // beyond the entry-date window that was written.
    //
    // REFUSED on a truncated pull (§6): attendance recomputed from a
    // partial punch fetch reads the missing tail as absences. The punches
    // above are already written (idempotent, safe); the recompute waits for
    // a complete pull — the next non-truncated run heals it.
    const quarters = distinctQuarters(boundedEntries.map((c) => c.entry_date));
    const touchedEmployees = new Set(boundedEntries.map((c) => c.employee_id));
    const jobs: RecomputeJob[] = [];
    if (!truncated) {
      for (const employee_id of touchedEmployees) {
        for (const q of quarters) jobs.push({ employee_id, year: q.year, quarter: q.quarter });
      }
    }
    const rc = await runRecomputeJobs(supabase, loc.id, jobs);

    if (payloads.length > 0) {
      await supabase
        .from("locations")
        .update({ last_data_uploaded_at: new Date().toISOString() })
        .eq("id", loc.id);
    }

    base.rows_upserted = upserted;
    base.rows_skipped =
      collapse.skippedOpen +
      collapse.skippedDeleted +
      collapse.unmatchedUserIds.length +
      entriesOutsideEntryWindow;
    base.detail = {
      punches_fetched: punches.length,
      truncated_at_page_cap: truncated,
      recompute_skipped_truncated_pull: truncated,
      entries_upserted: upserted,
      employees_touched: touchedEmployees.size,
      quarters_recomputed: truncated ? 0 : quarters.length,
      records_recomputed: rc.recomputed,
      records_created: rc.created,
      records_updated: rc.updated,
      records_skipped_no_activity: rc.skipped_no_activity,
      ...(entryWindow
        ? {
            entry_window: { from: entryWindow.from ?? null, to: entryWindow.to ?? null },
            entries_outside_entry_window: entriesOutsideEntryWindow,
          }
        : {}),
      skipped_open_punches: collapse.skippedOpen,
      skipped_deleted: collapse.skippedDeleted,
      unmatched_seven_shifts_user_ids: collapse.unmatchedUserIds,
      multi_role_days: collapse.multiRoleDays,
      unmapped_role_ids: Array.from(unmappedRoleIds),
      ...(rolesLookupError ? { roles_lookup_error: rolesLookupError } : {}),
      recompute_failures: rc.failures.slice(0, 20),
    };
    // A truncated pull must land as ERROR, not success/empty: the
    // incremental window math takes the max window_end over
    // success/empty runs, so a "successful" truncated run would advance
    // the high-water past punches it never fetched and the next nightly
    // would not heal it (Codex blocker 2026-08-25). Error keeps the
    // window where it was; the upserted punches are idempotent.
    base.status = truncated ? "error" : upserted > 0 ? "success" : "empty";
    const problems: string[] = [];
    if (truncated) {
      problems.push(
        "punch pull truncated at the page cap — punches written, recompute REFUSED, run marked error so the window does not advance (attendance from a partial fetch reads the missing tail as absences)"
      );
    }
    if (rolesLookupError) {
      problems.push("roles lookup failed — role column left untouched this run");
    }
    if (rc.failures.length > 0) {
      problems.push(`${rc.failures.length} recompute failure(s); see detail`);
    }
    if (problems.length > 0) base.error_text = problems.join("; ");
    return base;
  } catch (err) {
    base.status = "error";
    base.error_text = err instanceof Error ? err.message : String(err);
    return base;
  }
}
