/**
 * Store-wide attendance & punctuality, reported BOTH ways — all staff and
 * excluding management — side by side (mig 057, flip spec 2026-08-24 §1).
 *
 * ⚠️ SOURCES (the reason this module rides the FLIP PR, split out of the
 * mig 057 PR per Tucker 2026-08-24): for Toast stores this reads scheduled
 * shifts from seven_shifts_shifts (pruned: no tombstoned/deleted/draft
 * rows) and punches from toast_time_entries — the same sources the flip
 * gives the per-employee metrics. Computed from time_entries instead it
 * reads 73.1% at CPD against an actual 97.3% (72.0% vs 94.7% at DTD),
 * because time_entries' scheduled rows are upserted and never pruned (CP's
 * deletion-accumulation defect) and its worked rows miss the punches that
 * never reach 7shifts. A store card must never disagree with the employees
 * inside it. Non-Toast stores (NOLA — actuals_source='cake') keep the
 * time_entries path: their actuals genuinely live there.
 *
 * GM classification is a display/reporting dimension only: this module is
 * its ONE metric-adjacent consumer, and it never writes anything — the
 * store card renders both figures and neither is "the" number. Exclusion
 * from the actual metrics is deliberately NOT implemented: measured across
 * the seven Toast stores the two large excl-GM effects were the Toast
 * defect (GMs reading 0%), and at DTD/HRANCH the GM is the best attender
 * in the building, so excluding them makes the store look worse.
 *
 * Combining rule (non-negotiable): rates are recomputed from SUMMED
 * numerators and denominators across employees, never averaged.
 *
 * Non-punchers (mig 056) contribute no denominators for periods overlapping
 * their effective date — the punchesTimeClockForPeriod gate — exactly as in
 * the recompute entry points.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeMetricsFromEntries,
  punchesTimeClockForPeriod,
  type PerformanceMetrics,
} from "./performance-recompute";
import {
  fetchLocationFlipMeta,
  fetchEffectiveEntries,
  latestEffectiveWorkedDate,
} from "./flip-entries";

export interface StoreAttendanceParts {
  scheduled: number;
  attended: number;
  onTime: number;
  onTimeGrace: number;
  employees: number;
}

export interface StoreAttendanceRates {
  parts: StoreAttendanceParts;
  attendancePct: number | null;
  onTimePct: number | null;
  onTimeGracePct: number | null;
}

export interface StoreAttendanceBothWays {
  allStaff: StoreAttendanceRates;
  excludingManagement: StoreAttendanceRates;
  gmCount: number;
}

function rate(num: number, den: number): number | null {
  return den > 0 ? (num / den) * 100 : null;
}

function toRates(parts: StoreAttendanceParts): StoreAttendanceRates {
  return {
    parts,
    attendancePct: rate(parts.attended, parts.scheduled),
    // Punctuality denominators are attended shifts, mirroring the
    // per-employee metric definitions.
    onTimePct: rate(parts.onTime, parts.attended),
    onTimeGracePct: rate(parts.onTimeGrace, parts.attended),
  };
}

/**
 * Pure combiner: sum each employee's counts into store-wide parts, twice —
 * all staff and excluding GMs — and recompute rates from the sums.
 */
export function combineStoreMetrics(
  rows: Array<{ isGeneralManager: boolean; metrics: PerformanceMetrics }>
): StoreAttendanceBothWays {
  const empty = (): StoreAttendanceParts => ({
    scheduled: 0,
    attended: 0,
    onTime: 0,
    onTimeGrace: 0,
    employees: 0,
  });
  const all = empty();
  const exclGm = empty();
  let gmCount = 0;
  for (const { isGeneralManager, metrics } of rows) {
    if (isGeneralManager) gmCount += 1;
    for (const target of isGeneralManager ? [all] : [all, exclGm]) {
      target.scheduled += metrics.scheduled_count;
      target.attended += metrics.attended_count;
      target.onTime += metrics.on_time_count;
      target.onTimeGrace += metrics.on_time_grace_count;
      // Employees with no scheduled days in the window (including gated
      // non-punchers) carry no denominator weight either way; still count
      // heads only where there is a denominator contribution.
      if (metrics.scheduled_count > 0) target.employees += 1;
    }
  }
  return {
    allStaff: toRates(all),
    excludingManagement: toRates(exclGm),
    gmCount,
  };
}

/**
 * Fetch + compute for one location over an inclusive YYYY-MM-DD range.
 * Per-employee metrics via computeMetricsFromEntries with the same
 * scheduled-scored-through cap and mig 056 effective-date gate as the
 * recompute entry points, then summed via combineStoreMetrics.
 */
export async function computeStoreAttendance(
  supabase: SupabaseClient,
  locationId: string,
  periodStart: string,
  periodEnd: string
): Promise<StoreAttendanceBothWays> {
  // THE FLIP (2026-08-25): sources ride flip-entries.ts — the SAME layer
  // the recompute entry points use, so the store card and the employees
  // inside it can never disagree. (The card's local source builders moved
  // there and gained the day-conditional scheduled fallback.)
  const meta = await fetchLocationFlipMeta(supabase, locationId);

  type EmpRow = {
    id: string;
    is_general_manager: boolean | null;
    punches_time_clock: boolean | null;
    punches_time_clock_since: string | null;
  };
  const BATCH = 1000;
  const employees: EmpRow[] = [];
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await supabase
      .from("employees")
      .select("id, is_general_manager, punches_time_clock, punches_time_clock_since")
      .eq("location_id", locationId)
      .order("id", { ascending: true })
      .range(from, from + BATCH - 1);
    if (error) throw new Error(`store attendance employees: ${error.message}`);
    employees.push(...((data ?? []) as EmpRow[]));
    if (!data || data.length < BATCH) break;
  }
  if (employees.length === 0) return combineStoreMetrics([]);

  const entriesByEmployee = await fetchEffectiveEntries(
    supabase,
    locationId,
    employees.map((e) => e.id),
    { start: periodStart, end: periodEnd },
    meta
  );

  // Same cap as the recompute entry points: don't score scheduled days the
  // worked side hasn't reached yet — measured against the SAME effective
  // worked source the metrics use.
  const todayIso = new Date().toISOString().slice(0, 10);
  const latestWorkedDate = await latestEffectiveWorkedDate(supabase, locationId, meta);
  const scheduledScoredThrough =
    latestWorkedDate !== null && latestWorkedDate < todayIso
      ? latestWorkedDate
      : todayIso;

  const rows = employees.map((e) => ({
    isGeneralManager: e.is_general_manager === true,
    metrics: computeMetricsFromEntries(entriesByEmployee.get(e.id) ?? [], {
      scheduledScoredThrough,
      punchesTimeClock: punchesTimeClockForPeriod(
        e.punches_time_clock !== false,
        e.punches_time_clock_since ?? null,
        periodEnd
      ),
    }),
  }));

  return combineStoreMetrics(rows);
}
