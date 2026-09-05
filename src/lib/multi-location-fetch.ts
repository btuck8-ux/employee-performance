/**
 * Server-side assembly for the employee-profile multi-location combined view
 * (2026-08-23 sprint §4-B; REWORKED for the W6 composite identity, MASTER
 * sprint 2026-09-05). SERVER-ONLY — imports the Supabase client type and
 * runs queries; the pure combining math lives in multi-location-metrics.ts
 * and the pure selection model in multi-location-selection.ts.
 *
 * IDENTITY (the five CP3 defects, fixed here and in the card):
 * The unit is a STORE SLICE — the composite (employeeId, locationId) —
 * NOT an employee row. Slices come from two places:
 *   - sibling employee rows sharing a NON-NULL seven_shifts_user_id
 *     (§4-B2; null is never a join key), each contributing its CURRENT
 *     location, and
 *   - every DISTINCT performance_records.location_id those rows hold —
 *     post-093 location_id is part of row identity, so one transferred
 *     employee row legitimately holds history at several stores under one
 *     employeeId. That is case (a), precisely what the old fewer-than-two-
 *     employee-rows gate returned null for.
 * The surface renders when the person has ≥ 2 slices; a genuinely
 * single-location person still gets no card (§4-B1 preserved).
 *
 * THE FLOOR (defect 4): each slice's labor metrics are computed with that
 * store's own metrics_start_date via computeMetricsFromEntries's
 * metricsStartFloor — this surface must refuse below-line values exactly
 * like the rest of the application. A quarter wholly below a store's floor
 * is marked belowFloor so the card can attribute the hole (§11g), never
 * render it as 0.
 *
 * Attribution tables carry location_id, so tattle/review means bucket per
 * slice (a transferred row's two stores split correctly); survey counts and
 * the task-list mean come from the (employee, quarter, location)-keyed
 * performance_records row.
 *
 * RBAC: this module uses ONLY the caller's page-scoped client — the
 * existing role-scoped read path. No admin/service client is created here.
 *
 * ⚠️ Scheduled follow-up (PR note): sibling enumeration is 7shifts-id
 * based; the 09-07 identity migration changes that shape.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeMetricsFromEntries,
  punchesTimeClockForPeriod,
  type TimeEntryRow,
} from "./performance-recompute";
import {
  meanPartsFromValues,
  type LocationQuarterMetrics,
} from "./multi-location-metrics";
import {
  quarterBelowFloor,
  buildSliceList,
  attributionBelongsToSlice,
  type StoreSlice,
} from "./multi-location-selection";

export interface SiblingSlice extends StoreSlice {
  /** Mig 056 non-puncher marker — from the slice's EMPLOYEE row; each
   * slice's recompute honours its own row's flag. */
  punchesTimeClock: boolean;
  punchesTimeClockSince: string | null;
}

export interface MultiLocationQuarter {
  id: string;
  label: string;
  period_start: string;
  period_end: string;
}

export interface MultiLocationProfileData {
  siblings: SiblingSlice[];
  quarters: MultiLocationQuarter[];
  perLocationQuarter: LocationQuarterMetrics[];
}

interface NumLike {
  [k: string]: unknown;
}

function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && !Number.isNaN(n) ? n : null;
}

/** Page past PostgREST's 1000-row cap (Codex finding 3, 2026-08-23). */
async function pagedRows<T>(
  build: (from: number, to: number) => PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>,
  label: string
): Promise<T[]> {
  const out: T[] = [];
  const BATCH = 1000;
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await build(from, from + BATCH - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < BATCH) break;
  }
  return out;
}

/**
 * Null when the person has fewer than two store slices (single-location
 * profiles must not change, §4-B1) or no usable 7shifts id (§4-B2).
 */
export async function fetchMultiLocationProfile(
  supabase: SupabaseClient,
  employeeId: string,
  sevenShiftsUserId: number | null
): Promise<MultiLocationProfileData | null> {
  if (sevenShiftsUserId === null || !Number.isSafeInteger(sevenShiftsUserId))
    return null;

  const { data: siblingRows, error: siblingError } = await supabase
    .from("employees")
    .select(
      "id, employee_code, location_id, punches_time_clock, punches_time_clock_since"
    )
    .eq("seven_shifts_user_id", sevenShiftsUserId);
  if (siblingError)
    throw new Error(`multi-location siblings: ${siblingError.message}`);
  type EmpRow = {
    id: string;
    employee_code: string;
    location_id: string;
    punches_time_clock: boolean | null;
    punches_time_clock_since: string | null;
  };
  const empRows = ((siblingRows ?? []) as unknown as EmpRow[]);
  if (empRows.length === 0) return null;
  const empById = new Map(empRows.map((r) => [String(r.id), r]));
  const rowIds = empRows.map((r) => String(r.id));

  // performance_records with location_id (defect 2) — the historical
  // location axis is what turns one transferred row into several slices.
  const { data: recordRows, error: recordError } = await supabase
    .from("performance_records")
    .select(
      "employee_id, location_id, surveys_assigned, surveys_completed, avg_task_list_completion_pct, report_periods(id, label, period_start, period_end)"
    )
    .in("employee_id", rowIds);
  if (recordError)
    throw new Error(`multi-location records: ${recordError.message}`);
  type RecordRow = {
    employee_id: string;
    location_id: string | null;
    surveys_assigned: number | null;
    surveys_completed: number | null;
    avg_task_list_completion_pct: number | string | null;
    report_periods: {
      id: string;
      label: string;
      period_start: string;
      period_end: string;
    } | null;
  };
  const records = ((recordRows ?? []) as unknown as RecordRow[]).filter(
    (r) => r.report_periods !== null
  );

  // Slice set = current locations ∪ historical record locations, per row —
  // buildSliceList is pure and fixture-tested (dedup incl. the
  // roster-store-equals-record-store case).
  const sliceList = buildSliceList(empRows, records);
  if (sliceList.length < 2) return null;

  // Location names for every slice location (the old embedded join only
  // covered the row's current store).
  const locationIds = [...new Set(sliceList.map((s) => s.locationId))];
  const { data: locRows, error: locError } = await supabase
    .from("locations")
    .select("id, name")
    .in("id", locationIds);
  if (locError) throw new Error(`multi-location locations: ${locError.message}`);
  const locNameById = new Map(
    ((locRows ?? []) as NumLike[]).map((l) => [String(l.id), String(l.name)])
  );

  const siblings: SiblingSlice[] = sliceList.map((s) => {
    const emp = empById.get(s.employeeId)!;
    return {
      employeeId: s.employeeId,
      locationId: s.locationId,
      employeeCode: String(emp.employee_code),
      locationName: locNameById.get(s.locationId) ?? "—",
      punchesTimeClock: emp.punches_time_clock !== false,
      punchesTimeClockSince: emp.punches_time_clock_since ?? null,
    };
  });

  const quarters = [
    ...new Map(
      records.map((r) => [r.report_periods!.id, r.report_periods!])
    ).values(),
  ].sort((a, b) => b.period_start.localeCompare(a.period_start));
  if (quarters.length === 0) return null;

  const windowStart = quarters.reduce(
    (a, q) => (q.period_start < a ? q.period_start : a),
    quarters[0].period_start
  );
  const windowEnd = quarters.reduce(
    (a, q) => (q.period_end > a ? q.period_end : a),
    quarters[0].period_end
  );

  // THE FLIP (2026-08-25): each slice's entries and cap ride flip-entries —
  // fetched per (location, employee row), so a transferred row's history is
  // read at BOTH its stores. One flip-meta fetch per location; the meta
  // also carries the store's metrics_start floor (defect 4).
  const {
    fetchLocationFlipMeta,
    fetchEffectiveEntries,
    latestEffectiveWorkedDate,
    fetchRemovedShiftEvidence,
  } = await import("./flip-entries");
  const todayIso = new Date().toISOString().slice(0, 10);
  const metaByLocation = new Map<
    string,
    Awaited<ReturnType<typeof fetchLocationFlipMeta>>
  >();
  const capByLocation = new Map<string, string>();
  for (const locId of locationIds) {
    const meta = await fetchLocationFlipMeta(supabase, locId);
    metaByLocation.set(locId, meta);
    const latest = await latestEffectiveWorkedDate(supabase, locId, meta);
    capByLocation.set(
      locId,
      latest !== null && latest < todayIso ? latest : todayIso
    );
  }
  const entriesBySlice = new Map<string, TimeEntryRow[]>();
  const removedBySlice = new Map<
    string,
    import("./performance-recompute").RemovedShiftEvidence
  >();
  for (const s of siblings) {
    const meta = metaByLocation.get(s.locationId)!;
    const byEmployee = await fetchEffectiveEntries(
      supabase,
      s.locationId,
      [s.employeeId],
      { start: windowStart, end: windowEnd },
      meta
    );
    const key = `${s.employeeId}::${s.locationId}`;
    entriesBySlice.set(key, byEmployee.get(s.employeeId) ?? []);
    // Denominator spec rev 2 §3–§4: same evidence as the recompute entry
    // points — the combined profile and the store card must not disagree.
    const evidence = (
      await fetchRemovedShiftEvidence(supabase, s.locationId, [s.employeeId], {
        start: windowStart,
        end: windowEnd,
      })
    ).get(s.employeeId);
    if (evidence) removedBySlice.set(key, evidence);
  }

  // Tattle + review attributions, bucketed per slice: both tables carry the
  // survey's location_id, so a transferred row's two stores split correctly.
  type TattleRow = {
    employee_id: string;
    tattle_surveys: {
      location_id: string;
      tattle_rating: number | string | null;
      food_quality_score: number | string | null;
      accuracy_score: number | string | null;
      speed_of_service_score: number | string | null;
      date_experienced: string;
    };
  };
  const tattles = (
    await pagedRows<TattleRow>(
      (from, to) =>
        supabase
          .from("tattle_attributions")
          .select(
            "employee_id, tattle_surveys!inner(location_id, tattle_rating, food_quality_score, accuracy_score, speed_of_service_score, date_experienced)"
          )
          .in("employee_id", rowIds)
          .gte("tattle_surveys.date_experienced", windowStart)
          .lte("tattle_surveys.date_experienced", windowEnd)
          // TOTAL order (Codex CP3): employee_id alone leaves ties across
          // page boundaries — offset paging can then skip or duplicate.
          .order("employee_id", { ascending: true })
          .order("tattle_survey_id", { ascending: true })
          .range(from, to),
      "multi-location tattle"
    )
  ).filter((r) => r.tattle_surveys);

  type ReviewRow = {
    employee_id: string;
    customer_reviews: {
      location_id: string;
      rating: number | string | null;
      review_date: string;
    };
  };
  const reviews = (
    await pagedRows<ReviewRow>(
      (from, to) =>
        supabase
          .from("review_attributions")
          .select(
            "employee_id, customer_reviews!inner(location_id, rating, review_date)"
          )
          .in("employee_id", rowIds)
          .gte("customer_reviews.review_date", windowStart)
          .lte("customer_reviews.review_date", windowEnd)
          .order("employee_id", { ascending: true })
          .order("customer_review_id", { ascending: true })
          .range(from, to),
      "multi-location reviews"
    )
  ).filter((r) => r.customer_reviews);

  // performance_records keyed on the FULL composite (defect 3): with the
  // 093 location axis, one (employee, quarter) may hold several rows — one
  // per location — and they must never collapse or drop.
  const recordBySliceQuarter = new Map<string, RecordRow>();
  for (const r of records) {
    recordBySliceQuarter.set(
      `${r.employee_id}::${r.location_id}::${r.report_periods!.id}`,
      r
    );
  }

  const perLocationQuarter: LocationQuarterMetrics[] = [];
  for (const s of siblings) {
    const key = `${s.employeeId}::${s.locationId}`;
    const entries = entriesBySlice.get(key) ?? [];
    const meta = metaByLocation.get(s.locationId)!;
    for (const q of quarters) {
      const inQuarter = (d: string) =>
        d >= q.period_start && d <= q.period_end;
      const qEntries = entries.filter((e) => inQuarter(e.entry_date));
      const shift = computeMetricsFromEntries(qEntries, {
        scheduledScoredThrough: capByLocation.get(s.locationId),
        punchesTimeClock: punchesTimeClockForPeriod(
          s.punchesTimeClock,
          s.punchesTimeClockSince,
          q.period_end
        ),
        removedShifts: removedBySlice.get(key),
        // THE DEMARCATION FLOOR (defect 4): this store's own line. Without
        // it this surface published below-line values the rest of the app
        // refuses to compute.
        metricsStartFloor: meta.metricsStart,
      });
      const qTattles = tattles.filter(
        (t) =>
          attributionBelongsToSlice(
            t.employee_id,
            t.tattle_surveys.location_id,
            s
          ) && inQuarter(t.tattle_surveys.date_experienced.slice(0, 10))
      );
      const qReviews = reviews.filter(
        (r) =>
          attributionBelongsToSlice(
            r.employee_id,
            r.customer_reviews.location_id,
            s
          ) && inQuarter(r.customer_reviews.review_date.slice(0, 10))
      );
      const record = recordBySliceQuarter.get(`${key}::${q.id}`);
      perLocationQuarter.push({
        employeeId: s.employeeId,
        locationId: s.locationId,
        quarterId: q.id,
        belowFloor: quarterBelowFloor(q.period_end, meta.metricsStart),
        attendance: { num: shift.attended_count, den: shift.scheduled_count },
        onTime: { num: shift.on_time_count, den: shift.attended_count },
        onTimeGrace: {
          num: shift.on_time_grace_count,
          den: shift.attended_count,
        },
        surveyEngagement: {
          num: record?.surveys_completed ?? 0,
          den: record?.surveys_assigned ?? 0,
        },
        csRating: meanPartsFromValues(
          qReviews.map((r) => toNumOrNull(r.customer_reviews.rating))
        ),
        tattleRating: meanPartsFromValues(
          qTattles.map((t) => toNumOrNull(t.tattle_surveys.tattle_rating))
        ),
        tattleFood: meanPartsFromValues(
          qTattles.map((t) => toNumOrNull(t.tattle_surveys.food_quality_score))
        ),
        tattleAccuracy: meanPartsFromValues(
          qTattles.map((t) => toNumOrNull(t.tattle_surveys.accuracy_score))
        ),
        tattleSpeed: meanPartsFromValues(
          qTattles.map((t) =>
            toNumOrNull(t.tattle_surveys.speed_of_service_score)
          )
        ),
        tattleQuantity: qTattles.length,
        reviewQuantity: qReviews.length,
        avgTaskListCompletionPct: toNumOrNull(
          record?.avg_task_list_completion_pct ?? null
        ),
      });
    }
  }

  return { siblings, quarters, perLocationQuarter };
}
