/**
 * Store-wide attendance & punctuality, reported BOTH ways — all staff and
 * excluding management — side by side (mig 057, flip spec 2026-08-24 §1).
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
  type TimeEntryRow,
} from "./performance-recompute";

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
 * Mirrors the recompute entry points: per-employee metrics from
 * time_entries with the same scheduled-scored-through cap and the mig 056
 * effective-date gate, then summed via combineStoreMetrics.
 */
export async function computeStoreAttendance(
  supabase: SupabaseClient,
  locationId: string,
  periodStart: string,
  periodEnd: string
): Promise<StoreAttendanceBothWays> {
  const BATCH = 1000;

  type EmpRow = {
    id: string;
    is_general_manager: boolean | null;
    punches_time_clock: boolean | null;
    punches_time_clock_since: string | null;
  };
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

  // A store quarter is ~30 employees × ~90 days × 2 entry kinds — well past
  // the PostgREST row cap, so page (the multi-location-fetch precedent).
  const entriesByEmployee = new Map<string, TimeEntryRow[]>();
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await supabase
      .from("time_entries")
      .select("employee_id, entry_date, entry_type, in_time")
      .eq("location_id", locationId)
      .gte("entry_date", periodStart)
      .lte("entry_date", periodEnd)
      .order("id", { ascending: true })
      .range(from, from + BATCH - 1);
    if (error) throw new Error(`store attendance entries: ${error.message}`);
    for (const r of data ?? []) {
      const empId = String(r.employee_id);
      const list = entriesByEmployee.get(empId) ?? [];
      list.push({
        entry_date: String(r.entry_date),
        entry_type: r.entry_type as "scheduled" | "worked",
        in_time: (r.in_time as string | null) ?? null,
      });
      entriesByEmployee.set(empId, list);
    }
    if (!data || data.length < BATCH) break;
  }

  // Same cap as the recompute entry points: don't score scheduled days the
  // worked side hasn't reached yet.
  const todayIso = new Date().toISOString().slice(0, 10);
  const { data: latestWorked } = await supabase
    .from("time_entries")
    .select("entry_date")
    .eq("location_id", locationId)
    .eq("entry_type", "worked")
    .order("entry_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const latestWorkedDate = (latestWorked?.entry_date as string | undefined) ?? todayIso;
  const scheduledScoredThrough =
    latestWorkedDate < todayIso ? latestWorkedDate : todayIso;

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
