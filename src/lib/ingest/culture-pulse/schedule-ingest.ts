/**
 * EPD-side ingest for the CP schedule feed: resolve + collapse one location's
 * CP rows, upsert time_entries (entry_type 'scheduled'), recompute the touched
 * (employee × quarter) set (kickoff-ui-rbac-c-brand-2026-08-14.md §3).
 *
 * The upsert grain and batch size mirror the CSV-era scheduled path
 * (upload-time-actions.ts): onConflict (employee_id, entry_date, entry_type),
 * batches of 500. Deliberately does NOT touch locations.last_data_uploaded_at:
 * that timestamp backs the stale-locations card as a WORKED-data health
 * signal, and a forward-looking schedule pull landing nightly would mask a
 * dead actuals feed behind a green card.
 *
 * Recompute skips quarters that start in the future: the +21-day lookahead can
 * cross a quarter boundary, and pre-creating an empty next-quarter
 * performance_records row buys nothing (future scheduled shifts are already
 * excluded from attendance by scheduledScoredThrough).
 */

import { runRecomputeJobs, distinctQuarters, type RecomputeJob } from "../sevenshifts/recompute";
import { storeTimezone } from "../sevenshifts/tz";
import type { AdminClient } from "../sevenshifts/crosswalk";
import {
  buildScheduleRosterIndex,
  collapseCpSchedule,
  buildScheduledEntryPayload,
  type CpScheduleRow,
  type ScheduleRosterEmployee,
} from "./schedule-resolve";

const UPSERT_BATCH = 500;

export interface ScheduleIngestStats {
  entries_upserted: number;
  /** Collapsed (employee, day) entries whose LOCAL date fell outside the
   * requested window (the fetch over-pulls a day each side by design). */
  out_of_window: number;
  employees_touched: number;
  quarters_recomputed: number;
  records_recomputed: number;
  resolved_by_code: number;
  resolved_by_seven_shifts_id: number;
  unmatched: string[];
  inactive_skipped: string[];
  unmatched_rows: number;
  inactive_rows: number;
  skipped_no_start: number;
  multi_shift_days: number;
  failures: string[];
}

export async function ingestCpSchedulesForLocation(
  supabase: AdminClient,
  loc: { id: string; location_code: string; timezone: string | null },
  rows: CpScheduleRow[],
  window: { sinceDate: string; untilDate: string }
): Promise<ScheduleIngestStats> {
  const tz = storeTimezone(loc);

  const { data: rosterRows, error: rosterErr } = await supabase
    .from("employees")
    .select("id, employee_name, employee_code, seven_shifts_user_id, active")
    .eq("location_id", loc.id);
  if (rosterErr) throw new Error(`employee roster lookup: ${rosterErr.message}`);

  const index = buildScheduleRosterIndex(
    (rosterRows ?? []) as ScheduleRosterEmployee[]
  );
  const collapse = collapseCpSchedule(rows, index, tz);

  // Trim to the exact LOCAL-date window: the UTC fetch over-pulls a day on
  // each side so edge shifts project correctly; anything landing outside
  // [since, until] — notably pre-backfill-floor dates that CSV-era rows own
  // — must not be written (Codex findings 1+2, 2026-08-14).
  const inWindow = collapse.entries.filter(
    (e) => e.entry_date >= window.sinceDate && e.entry_date <= window.untilDate
  );
  const outOfWindow = collapse.entries.length - inWindow.length;

  const payloads = inWindow.map((e) => buildScheduledEntryPayload(e, loc.id));

  let upserted = 0;
  for (let i = 0; i < payloads.length; i += UPSERT_BATCH) {
    const batch = payloads.slice(i, i + UPSERT_BATCH);
    const { error } = await supabase
      .from("time_entries")
      .upsert(batch, { onConflict: "employee_id,entry_date,entry_type" });
    if (error) throw new Error(`time_entries upsert: ${error.message}`);
    upserted += batch.length;
  }

  // Recompute touched (employee × quarter), current-or-past quarters only.
  const today = new Date().toISOString().slice(0, 10);
  const quarters = distinctQuarters(
    inWindow.map((e) => e.entry_date)
  ).filter((q) => {
    const startMonth = (q.quarter - 1) * 3 + 1;
    const quarterStart = `${q.year}-${String(startMonth).padStart(2, "0")}-01`;
    return quarterStart <= today;
  });
  const touchedEmployees = new Set(inWindow.map((e) => e.employee_id));
  const jobs: RecomputeJob[] = [];
  for (const employee_id of touchedEmployees) {
    for (const q of quarters) {
      jobs.push({ employee_id, year: q.year, quarter: q.quarter });
    }
  }
  const rc = await runRecomputeJobs(supabase, loc.id, jobs);

  return {
    entries_upserted: upserted,
    out_of_window: outOfWindow,
    employees_touched: touchedEmployees.size,
    quarters_recomputed: quarters.length,
    records_recomputed: rc.recomputed,
    resolved_by_code: collapse.resolved_by_code,
    resolved_by_seven_shifts_id: collapse.resolved_by_seven_shifts_id,
    unmatched: collapse.unmatched,
    inactive_skipped: collapse.inactive_skipped,
    unmatched_rows: collapse.unmatched_rows,
    inactive_rows: collapse.inactive_rows,
    skipped_no_start: collapse.skipped_no_start,
    multi_shift_days: collapse.multi_shift_days,
    failures: rc.failures,
  };
}
