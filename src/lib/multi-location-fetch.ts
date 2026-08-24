/**
 * Server-side assembly for the employee-profile multi-location combined view
 * (2026-08-23 sprint §4-B). SERVER-ONLY — imports the Supabase client type
 * and runs queries; the pure combining math lives in multi-location-metrics.ts
 * so the client card can recombine subsets without a round-trip.
 *
 * Identity: a person's location set is the set of `employees` rows sharing
 * their NON-NULL seven_shifts_user_id (§4-B2). Null is never a join key —
 * the two null-id NOLA rows are single-location by definition. Names are
 * never matched (Ryan Griffin ≠ Connor Griffin).
 *
 * The two stored-rate gaps (§4-B3): performance_records does not carry the
 * counts behind attendance_pct / on_time(_grace)_pct, so those are
 * RECOMPUTED per location per quarter via computeMetricsFromEntries — one
 * call per (employee-row, quarter), never pooled across locations (its
 * scheduledByDate map keys on the date alone, so pooling would silently
 * collapse same-day shifts at two stores, §4-B4). Each location keeps its
 * own scheduledScoredThrough cap = min(today, latest worked at THAT
 * location), matching the stored quarterly path exactly.
 *
 * Tattle + review means are recomputed from the attribution tables over
 * each sibling row so the (sum, n) parts carry the metric's true non-null
 * denominators (§4-B6 — see multi-location-metrics.ts header).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeMetricsFromEntries,
  type TimeEntryRow,
} from "./performance-recompute";
import {
  meanPartsFromValues,
  type LocationQuarterMetrics,
} from "./multi-location-metrics";

export interface SiblingLocation {
  employeeId: string;
  employeeCode: string;
  locationId: string;
  locationName: string;
  /** Mig 056 non-puncher marker — each site's recompute honours its own
   * row's flag so an excluded sibling contributes no denominators. */
  punchesTimeClock: boolean;
}

export interface MultiLocationQuarter {
  id: string;
  label: string;
  period_start: string;
  period_end: string;
}

export interface MultiLocationProfileData {
  siblings: SiblingLocation[];
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

/** Page past PostgREST's 1000-row cap (Codex finding 3, 2026-08-23): a
 * long-tenured two-site person's window can exceed it, and a silently
 * truncated read would flow into the combiner as a wrong rate. */
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
 * Null when the person has fewer than two roster rows (single-location
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
    .select("id, employee_code, location_id, punches_time_clock, locations(id, name)")
    .eq("seven_shifts_user_id", sevenShiftsUserId);
  if (siblingError)
    throw new Error(`multi-location siblings: ${siblingError.message}`);
  const siblings: SiblingLocation[] = ((siblingRows ?? []) as NumLike[]).map(
    (r) => ({
      employeeId: String(r.id),
      employeeCode: String(r.employee_code),
      locationId: String(r.location_id),
      locationName:
        ((r.locations as { name?: string } | null)?.name as string) ?? "—",
      punchesTimeClock: r.punches_time_clock !== false,
    })
  );
  if (siblings.length < 2) return null;

  const siblingIds = siblings.map((s) => s.employeeId);

  // Quarters = union across siblings' performance_records.
  const { data: recordRows, error: recordError } = await supabase
    .from("performance_records")
    .select(
      "employee_id, surveys_assigned, surveys_completed, avg_task_list_completion_pct, report_periods(id, label, period_start, period_end)"
    )
    .in("employee_id", siblingIds);
  if (recordError)
    throw new Error(`multi-location records: ${recordError.message}`);
  type RecordRow = {
    employee_id: string;
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

  // Per-location attendance cap, matching computeMetricsForRange exactly.
  const todayIso = new Date().toISOString().slice(0, 10);
  const capByLocation = new Map<string, string>();
  for (const s of siblings) {
    const { data: latestWorked, error: capError } = await supabase
      .from("time_entries")
      .select("entry_date")
      .eq("location_id", s.locationId)
      .eq("entry_type", "worked")
      .order("entry_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (capError) throw new Error(`multi-location cap: ${capError.message}`);
    const latest = (latestWorked?.entry_date as string | undefined) ?? todayIso;
    capByLocation.set(s.locationId, latest < todayIso ? latest : todayIso);
  }

  // One time_entries read per sibling row (they are different employee ids —
  // the §4-B4 join detail), then bucket per quarter.
  const entriesBySibling = new Map<string, TimeEntryRow[]>();
  for (const s of siblings) {
    const entries = await pagedRows<TimeEntryRow>(
      (from, to) =>
        supabase
          .from("time_entries")
          .select("entry_date, entry_type, in_time")
          .eq("employee_id", s.employeeId)
          .gte("entry_date", windowStart)
          .lte("entry_date", windowEnd)
          .order("entry_date", { ascending: true })
          .range(from, to),
      "multi-location entries"
    );
    entriesBySibling.set(s.employeeId, entries);
  }

  // Tattle + review attributions per sibling across the whole window,
  // bucketed per quarter below.
  type TattleRow = {
    employee_id: string;
    tattle_surveys: {
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
            "employee_id, tattle_surveys!inner(tattle_rating, food_quality_score, accuracy_score, speed_of_service_score, date_experienced)"
          )
          .in("employee_id", siblingIds)
          .gte("tattle_surveys.date_experienced", windowStart)
          .lte("tattle_surveys.date_experienced", windowEnd)
          .order("employee_id", { ascending: true })
          .range(from, to),
      "multi-location tattle"
    )
  ).filter((r) => r.tattle_surveys);

  type ReviewRow = {
    employee_id: string;
    customer_reviews: { rating: number | string | null; review_date: string };
  };
  const reviews = (
    await pagedRows<ReviewRow>(
      (from, to) =>
        supabase
          .from("review_attributions")
          .select("employee_id, customer_reviews!inner(rating, review_date)")
          .in("employee_id", siblingIds)
          .gte("customer_reviews.review_date", windowStart)
          .lte("customer_reviews.review_date", windowEnd)
          .order("employee_id", { ascending: true })
          .range(from, to),
      "multi-location reviews"
    )
  ).filter((r) => r.customer_reviews);

  const recordBySiblingQuarter = new Map<string, RecordRow>();
  for (const r of records) {
    recordBySiblingQuarter.set(`${r.employee_id}|${r.report_periods!.id}`, r);
  }

  const perLocationQuarter: LocationQuarterMetrics[] = [];
  for (const s of siblings) {
    const entries = entriesBySibling.get(s.employeeId) ?? [];
    for (const q of quarters) {
      const inQuarter = (d: string) =>
        d >= q.period_start && d <= q.period_end;
      const qEntries = entries.filter((e) => inQuarter(e.entry_date));
      const shift = computeMetricsFromEntries(qEntries, {
        scheduledScoredThrough: capByLocation.get(s.locationId),
        punchesTimeClock: s.punchesTimeClock,
      });
      const qTattles = tattles.filter(
        (t) =>
          t.employee_id === s.employeeId &&
          inQuarter(t.tattle_surveys.date_experienced.slice(0, 10))
      );
      const qReviews = reviews.filter(
        (r) =>
          r.employee_id === s.employeeId &&
          inQuarter(r.customer_reviews.review_date.slice(0, 10))
      );
      const record = recordBySiblingQuarter.get(`${s.employeeId}|${q.id}`);
      perLocationQuarter.push({
        employeeId: s.employeeId,
        quarterId: q.id,
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
