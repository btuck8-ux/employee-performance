/**
 * Land a CAKE timesheet CSV into time_entries and recompute the touched
 * (employee x quarter) performance records. The CAKE analog of
 * backfill-worked-time + sevenshifts/time.ts, but CSV-fed and joined on
 * cake_profile_id (API-independent by design — does not depend on the CAKE
 * Labor API). Idempotent: re-running the same CSV upserts on the unique key
 * (employee_id, entry_date, entry_type) and adds zero rows.
 */

import type { AdminClient } from "../sevenshifts/crosswalk";
import type { RunOutcome } from "../sevenshifts/runs";
import { distinctQuarters, runRecomputeJobs, type RecomputeJob } from "../sevenshifts/recompute";
import {
  parseCakeTimesheetCsv,
  type CakeProfile,
  type CakeTimeEntry,
} from "./timesheet-csv";
import { cakeLocation } from "./nola-location";

/** Load cake_profile_crosswalk into a profile_id -> identity map. */
export async function loadCakeCrosswalk(
  supabase: AdminClient
): Promise<Map<number, CakeProfile>> {
  const { data, error } = await supabase
    .from("cake_profile_crosswalk")
    .select("cake_profile_id, employee_id, location_id, employee_code, full_name");
  if (error) throw new Error(`Failed to load cake_profile_crosswalk: ${error.message}`);
  const map = new Map<number, CakeProfile>();
  for (const r of data ?? []) {
    map.set(Number(r.cake_profile_id), {
      employee_id: r.employee_id as string,
      location_id: r.location_id as string,
      employee_code: r.employee_code as string,
      full_name: r.full_name as string,
    });
  }
  return map;
}

export interface CakeIngestResult extends RunOutcome {
  unmapped_profile_ids: number[];
}

/**
 * Parse + upsert + recompute. `windowStart`/`windowEnd` (YYYY-MM-DD, inclusive)
 * bound which business dates are loaded; omit to load everything in the CSV.
 */
export async function ingestCakeTimesheetCsv(
  supabase: AdminClient,
  csvText: string,
  opts?: { windowStart?: string; windowEnd?: string }
): Promise<CakeIngestResult> {
  // The run's location label comes from the DB fact (actuals_source='cake'),
  // never a hardcoded code (LOCATION_CODES packet 2026-08-26).
  const cake = await cakeLocation(supabase);
  const base: CakeIngestResult = {
    source: "cake_timesheets",
    location_id: cake.id,
    location_code: cake.location_code,
    status: "running",
    rows_in: 0,
    rows_upserted: 0,
    rows_skipped: 0,
    detail: null,
    error_text: null,
    window_start: opts?.windowStart ?? null,
    window_end: opts?.windowEnd ?? null,
    unmapped_profile_ids: [],
  };

  try {
    const crosswalk = await loadCakeCrosswalk(supabase);
    const parsed = parseCakeTimesheetCsv(csvText, crosswalk, opts);
    base.rows_in = parsed.rows_in_window;
    base.unmapped_profile_ids = parsed.unmapped_profile_ids;

    const records = parsed.records;
    // The crosswalk is single-location (NOLA); record the location for the run.
    const locationIds = new Set(records.map((r) => r.location_id));
    base.location_id = records[0]?.location_id ?? "";

    const payloads = records.map((c: CakeTimeEntry) => ({
      employee_id: c.employee_id,
      location_id: c.location_id,
      entry_date: c.entry_date,
      entry_type: "worked" as const,
      in_time: c.in_time,
      out_time: c.out_time,
      role: c.role,
      wage: c.wage,
      regular_hours: c.regular_hours,
      ot_hours: 0,
      double_ot_hours: 0,
      holiday_hours: 0,
      regular_pay: c.regular_pay,
      ot_pay: 0,
      double_ot_pay: 0,
      holiday_pay: 0,
      total_pay: c.regular_pay,
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

    // Recompute (employee x affected quarter) for touched employees, per location.
    const quarters = distinctQuarters(payloads.map((p) => p.entry_date));
    let recomputed = 0;
    const failures: string[] = [];
    for (const locId of locationIds) {
      const emps = new Set(
        payloads.filter((p) => p.location_id === locId).map((p) => p.employee_id)
      );
      const jobs: RecomputeJob[] = [];
      for (const employee_id of emps) {
        for (const q of quarters) jobs.push({ employee_id, year: q.year, quarter: q.quarter });
      }
      const rc = await runRecomputeJobs(supabase, locId, jobs);
      recomputed += rc.recomputed;
      failures.push(...rc.failures);
    }

    if (payloads.length > 0 && base.location_id) {
      await supabase
        .from("locations")
        .update({ last_data_uploaded_at: new Date().toISOString() })
        .eq("id", base.location_id);
    }

    base.rows_upserted = upserted;
    base.rows_skipped = parsed.rows_in_file - parsed.rows_in_window;
    base.detail = {
      rows_in_file: parsed.rows_in_file,
      shifts_in_window: parsed.rows_in_window,
      day_rows_upserted: upserted,
      employees_touched: new Set(payloads.map((p) => p.employee_id)).size,
      quarters_recomputed: quarters.length,
      records_recomputed: recomputed,
      unmapped_profile_ids: parsed.unmapped_profile_ids,
      parse_warnings: parsed.warnings,
      recompute_failures: failures.slice(0, 20),
      recompute_failure_count: failures.length,
    };
    base.status = upserted > 0 ? "success" : "empty";
    if (failures.length > 0) base.error_text = `${failures.length} recompute failure(s); see detail`;
    return base;
  } catch (err) {
    base.status = "error";
    base.error_text = err instanceof Error ? err.message : String(err);
    return base;
  }
}
