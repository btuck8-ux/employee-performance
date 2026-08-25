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
  type TimeEntryRow,
} from "./performance-recompute";
import {
  timezoneForLocationCode,
  utcToLocalWallClock,
} from "./ingest/sevenshifts/tz";

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

const BATCH = 1000;

/** employee id -> business date -> "HH:MM:SS" local (or null), earliest wins. */
type TimesByEmployee = Map<string, Map<string, string | null>>;

function setEarliest(
  map: TimesByEmployee,
  employeeId: string,
  date: string,
  localTime: string | null
): void {
  const byDate = map.get(employeeId) ?? new Map<string, string | null>();
  const prev = byDate.get(date);
  if (
    prev === undefined ||
    (localTime !== null && (prev === null || localTime < prev))
  ) {
    byDate.set(date, localTime);
  }
  map.set(employeeId, byDate);
}

/**
 * Toast-store inputs: scheduled from the pruned direct 7shifts feed
 * (earliest shift wins a multi-shift day — the matcher's
 * scheduledStartsByEmployee shape), punches from the Toast mirror
 * (earliest clock-in wins), both projected to store-local wall clock so
 * punctuality compares like with like. Unattributed rows (null
 * employee_id) are the crosswalk queue, not evidence — skipped.
 */
async function toastEntriesByEmployee(
  supabase: SupabaseClient,
  locationId: string,
  timeZone: string,
  periodStart: string,
  periodEnd: string
): Promise<Map<string, TimeEntryRow[]>> {
  const scheduled: TimesByEmployee = new Map();
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await supabase
      .from("seven_shifts_shifts")
      .select("employee_id, entry_date, start_at")
      .eq("location_id", locationId)
      .not("employee_id", "is", null)
      .is("missing_upstream_since", null)
      .eq("deleted", false)
      .eq("draft", false)
      .gte("entry_date", periodStart)
      .lte("entry_date", periodEnd)
      .order("seven_shifts_shift_id", { ascending: true })
      .range(from, from + BATCH - 1);
    if (error) throw new Error(`store attendance shifts: ${error.message}`);
    for (const r of data ?? []) {
      setEarliest(
        scheduled,
        String(r.employee_id),
        String(r.entry_date).slice(0, 10),
        utcToLocalWallClock(r.start_at as string, timeZone)?.time ?? null
      );
    }
    if (!data || data.length < BATCH) break;
  }

  const worked: TimesByEmployee = new Map();
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await supabase
      .from("toast_time_entries")
      .select("employee_id, entry_date, in_at")
      .eq("location_id", locationId)
      .not("employee_id", "is", null)
      .eq("deleted", false)
      .gte("entry_date", periodStart)
      .lte("entry_date", periodEnd)
      .order("toast_time_entry_guid", { ascending: true })
      .range(from, from + BATCH - 1);
    if (error) throw new Error(`store attendance punches: ${error.message}`);
    for (const r of data ?? []) {
      setEarliest(
        worked,
        String(r.employee_id),
        String(r.entry_date).slice(0, 10),
        utcToLocalWallClock(r.in_at as string, timeZone)?.time ?? null
      );
    }
    if (!data || data.length < BATCH) break;
  }

  const out = new Map<string, TimeEntryRow[]>();
  const push = (
    source: TimesByEmployee,
    entry_type: "scheduled" | "worked"
  ): void => {
    for (const [empId, byDate] of source) {
      const list = out.get(empId) ?? [];
      for (const [entry_date, in_time] of byDate) {
        list.push({ entry_date, entry_type, in_time });
      }
      out.set(empId, list);
    }
  };
  push(scheduled, "scheduled");
  push(worked, "worked");
  return out;
}

/** Legacy path for non-Toast stores (NOLA): actuals genuinely live in
 * time_entries via the CAKE harvester. A store quarter is well past the
 * PostgREST row cap, so page (the multi-location-fetch precedent). */
async function timeEntriesByEmployee(
  supabase: SupabaseClient,
  locationId: string,
  periodStart: string,
  periodEnd: string
): Promise<Map<string, TimeEntryRow[]>> {
  const out = new Map<string, TimeEntryRow[]>();
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
      const list = out.get(empId) ?? [];
      list.push({
        entry_date: String(r.entry_date),
        entry_type: r.entry_type as "scheduled" | "worked",
        in_time: (r.in_time as string | null) ?? null,
      });
      out.set(empId, list);
    }
    if (!data || data.length < BATCH) break;
  }
  return out;
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
  const { data: loc, error: locError } = await supabase
    .from("locations")
    .select("location_code, toast_restaurant_guid")
    .eq("id", locationId)
    .maybeSingle();
  if (locError) throw new Error(`store attendance location: ${locError.message}`);
  const isToastStore = Boolean(loc?.toast_restaurant_guid);

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

  const entriesByEmployee = isToastStore
    ? await toastEntriesByEmployee(
        supabase,
        locationId,
        timezoneForLocationCode(String(loc?.location_code ?? "")),
        periodStart,
        periodEnd
      )
    : await timeEntriesByEmployee(supabase, locationId, periodStart, periodEnd);

  // Same cap as the recompute entry points: don't score scheduled days the
  // worked side hasn't reached yet — measured against the SAME worked
  // source the metrics use (Toast punches for Toast stores).
  const todayIso = new Date().toISOString().slice(0, 10);
  const workedQuery = isToastStore
    ? supabase
        .from("toast_time_entries")
        .select("entry_date")
        .eq("location_id", locationId)
        .eq("deleted", false)
    : supabase
        .from("time_entries")
        .select("entry_date")
        .eq("location_id", locationId)
        .eq("entry_type", "worked");
  const { data: latestWorked } = await workedQuery
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
