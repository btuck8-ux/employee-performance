/**
 * Worked-day coverage health check for the nightly ingest.
 *
 * The backfill guard (orchestrator firstRunFloor) widens a location's FIRST
 * window to the quarter start, but it cannot heal a hole a location already has
 * from a mid-quarter cron start — that needs a one-time backfill (handoff §4).
 * This check is the detector: for each location whose worked actuals come from
 * 7shifts, it compares the distinct worked days this quarter against the days
 * elapsed in the quarter and flags any location under COVERAGE_THRESHOLD. Its
 * reasons feed the nightly alert alongside the empty-streak guard, so a
 * quarter-wide gap surfaces within a night instead of drifting silent (§3).
 *
 * "Elapsed days" is the denominator because there is no per-location operating
 * calendar (open/closed days, holidays). The 80% threshold leaves slack for a
 * weekly closure (~14%) so a 6-day-a-week store does not false-alarm, while a
 * true quarter-wide hole sits far below it.
 *
 * Like streak.ts, this module imports ONLY types so the repo's `node --test`
 * runner (no path-alias loader) can load it for the pure-function tests. The
 * orchestrator computes the quarter window via currentQuarter() and passes the
 * primitives in.
 */

import type { AdminClient, LocationCrosswalk } from "./crosswalk";
import type { QuarterInfo } from "@/lib/quarter";

/** Worked-day coverage under this fraction of elapsed quarter days alerts. */
export const COVERAGE_THRESHOLD = 0.8;

/** PostgREST page size — time_entries has one row per (employee, date), so a
 * quarter routinely exceeds the 1000-row default and must be paged to count
 * distinct days correctly. */
const PAGE = 1000;

/** The quarter slice the coverage check is measured against. */
export interface QuarterWindow {
  startIso: string; // quarter start, YYYY-MM-DD
  endIso: string; // min(today, quarter end), YYYY-MM-DD
  expectedDays: number; // inclusive day count startIso..endIso
  label: string; // e.g. "Q2 2026"
}

export interface CoverageReport {
  location_id: string;
  location_code: string;
  worked_days: number;
  expected_days: number;
  coverage_pct: number; // 0..1, rounded to 3 dp for display
  below_threshold: boolean;
}

/** Local-date YYYY-MM-DD. Avoids the UTC shift toISOString() would apply to a
 * local-midnight Date in a negative-offset timezone (e.g. Phoenix UTC-7 would
 * roll quarter-start back to the prior day). */
export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Inclusive day count between two local dates. */
function inclusiveDays(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000)) + 1;
}

/** Build the coverage window from a quarter and "today": quarter start through
 * the earlier of today / quarter end. Pure — caller supplies currentQuarter(). */
export function quarterCoverageWindow(q: QuarterInfo, today: Date): QuarterWindow {
  const end = today < q.periodEnd ? today : q.periodEnd;
  return {
    startIso: isoDate(q.periodStart),
    endIso: isoDate(end),
    expectedDays: inclusiveDays(q.periodStart, end),
    label: q.label,
  };
}

/** Distinct worked entry_dates for a location in [startIso, endIso], paged.
 * Returns null on a lookup error so the caller can skip that location. */
async function countWorkedDays(
  supabase: AdminClient,
  locationId: string,
  win: QuarterWindow,
  locationCode: string
): Promise<number | null> {
  const distinct = new Set<string>();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("time_entries")
      .select("entry_date")
      .eq("location_id", locationId)
      .eq("entry_type", "worked")
      .gte("entry_date", win.startIso)
      .lte("entry_date", win.endIso)
      .order("entry_date", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn(
        `[ingest/coverage] worked-day lookup failed (${locationCode}): ${error.message}`
      );
      return null;
    }
    const rows = data ?? [];
    for (const r of rows) distinct.add(r.entry_date as string);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return distinct.size;
}

/**
 * Compute worked-day coverage for every 7shifts-sourced location over the given
 * quarter window. CAKE-sourced locations (NOLA, migration 033) are skipped —
 * their worked actuals do not come from the 7shifts time pull this watches.
 *
 * Never throws: a failed lookup logs and that location is omitted, mirroring the
 * rest of the ingest path where the durable tables are the source of truth.
 */
export async function quarterWorkedCoverage(
  supabase: AdminClient,
  crosswalk: LocationCrosswalk[],
  win: QuarterWindow
): Promise<CoverageReport[]> {
  const reports: CoverageReport[] = [];

  for (const loc of crosswalk) {
    if (loc.actuals_source !== "7shifts") continue;

    const workedDays = await countWorkedDays(supabase, loc.id, win, loc.location_code);
    if (workedDays === null) continue;

    const pct = win.expectedDays > 0 ? workedDays / win.expectedDays : 1;
    reports.push({
      location_id: loc.id,
      location_code: loc.location_code,
      worked_days: workedDays,
      expected_days: win.expectedDays,
      coverage_pct: Math.round(pct * 1000) / 1000,
      below_threshold: pct < COVERAGE_THRESHOLD,
    });
  }

  return reports;
}

/** Pure: turn below-threshold reports into human alert reason strings. */
export function coverageReasons(reports: CoverageReport[], quarterLabel: string): string[] {
  return reports
    .filter((r) => r.below_threshold)
    .map(
      (r) =>
        `${r.location_code} worked coverage ${r.worked_days}/${r.expected_days} days ` +
        `(${Math.round(r.coverage_pct * 100)}%) below ${Math.round(
          COVERAGE_THRESHOLD * 100
        )}% for ${quarterLabel}`
    );
}
