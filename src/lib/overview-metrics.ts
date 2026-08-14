/**
 * Overview per-store metric averages (kickoff §5a + Tucker's §8-E override:
 * quarter picker AND a custom date-range mode).
 *
 * Exactly six display metrics, unweighted mean over employees per store.
 * Null discipline is non-negotiable and mirrors the wire contract: null =
 * not-computed, EXCLUDED from the mean, never coalesced to 0; every cell
 * carries its n-count.
 *
 * Quarter mode reads performance_records (the canonical quarterly store).
 * Custom-range mode calls computeMetricsForRange PER EMPLOYEE — the same
 * canonical range engine the custom-range PDF uses — through a small worker
 * pool. Deliberately NOT a bulk SQL reimplementation: the range math (grace
 * boundaries, scheduledScoredThrough caps, attribution rules) lives in ONE
 * place (TS↔SQL lockstep doctrine; a parallel aggregate would drift).
 */

import type { createClient } from "@/lib/supabase/server";
import { computeMetricsForRange } from "@/lib/performance-recompute";
import { numOrNull } from "@/lib/format";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export const OVERVIEW_METRICS = [
  // Display name diverges from the customer_service_rating column name
  // deliberately (2026-08-14 rename) — wire/DB names untouched.
  { key: "customer_service_rating", label: "Online Review Rating", kind: "rating" },
  { key: "attendance_pct", label: "Attendance", kind: "percent" },
  { key: "on_time_grace_pct", label: "On-Time", kind: "percent" },
  { key: "survey_engagement_pct", label: "Survey Engagement", kind: "percent" },
  { key: "avg_task_list_completion_pct", label: "7Tasks Completion", kind: "percent" },
  { key: "tattle_rating", label: "Tattle Rating", kind: "rating" },
] as const;

export type OverviewMetricKey = (typeof OVERVIEW_METRICS)[number]["key"];

export interface MetricCell {
  mean: number | null;
  n: number;
}

export type MetricCells = Record<OverviewMetricKey, MetricCell>;

export interface StoreMetricsRow {
  location_id: string;
  name: string;
  location_code: string | null;
  employee_count: number;
  cells: MetricCells;
}

export interface OverviewMetricsResult {
  stores: StoreMetricsRow[];
  /** Unweighted mean over ALL employees of the selected stores (same rule). */
  rollup: MetricCells;
  rollupEmployeeCount: number;
}

type MetricSample = Record<OverviewMetricKey, number | null>;

function emptyCells(): MetricCells {
  const cells = {} as MetricCells;
  for (const m of OVERVIEW_METRICS) cells[m.key] = { mean: null, n: 0 };
  return cells;
}

function meanCells(samples: MetricSample[]): MetricCells {
  const cells = emptyCells();
  for (const m of OVERVIEW_METRICS) {
    const values = samples
      .map((s) => s[m.key])
      .filter((v): v is number => v !== null && Number.isFinite(v));
    cells[m.key] = {
      mean: values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null,
      n: values.length,
    };
  }
  return cells;
}

interface StoreRef {
  id: string;
  name: string;
  location_code: string | null;
}

function assemble(
  stores: StoreRef[],
  samplesByStore: Map<string, MetricSample[]>
): OverviewMetricsResult {
  const rows: StoreMetricsRow[] = stores.map((s) => {
    const samples = samplesByStore.get(s.id) ?? [];
    return {
      location_id: s.id,
      name: s.name,
      location_code: s.location_code,
      employee_count: samples.length,
      cells: meanCells(samples),
    };
  });
  const allSamples = stores.flatMap((s) => samplesByStore.get(s.id) ?? []);
  return {
    stores: rows,
    rollup: meanCells(allSamples),
    rollupEmployeeCount: allSamples.length,
  };
}

/** Quarter mode: one query over performance_records for the period. */
export async function computeQuarterOverview(
  supabase: SupabaseServerClient,
  stores: StoreRef[],
  reportPeriodId: string
): Promise<OverviewMetricsResult> {
  const { data, error } = await supabase
    .from("performance_records")
    .select(
      "location_id, customer_service_rating, attendance_pct, on_time_grace_pct, survey_engagement_pct, avg_task_list_completion_pct, tattle_rating"
    )
    .eq("report_period_id", reportPeriodId)
    .in(
      "location_id",
      stores.map((s) => s.id)
    );
  if (error) {
    console.error("[overview] performance_records fetch failed", {
      message: error.message,
    });
  }

  const samplesByStore = new Map<string, MetricSample[]>();
  for (const r of data ?? []) {
    const sample: MetricSample = {
      customer_service_rating: numOrNull(r.customer_service_rating),
      attendance_pct: numOrNull(r.attendance_pct),
      on_time_grace_pct: numOrNull(r.on_time_grace_pct),
      survey_engagement_pct: numOrNull(r.survey_engagement_pct),
      avg_task_list_completion_pct: numOrNull(r.avg_task_list_completion_pct),
      tattle_rating: numOrNull(r.tattle_rating),
    };
    const list = samplesByStore.get(r.location_id as string) ?? [];
    list.push(sample);
    samplesByStore.set(r.location_id as string, list);
  }
  return assemble(stores, samplesByStore);
}

const RANGE_CONCURRENCY = 6;

/**
 * Custom-range mode: canonical per-employee range engine, pooled. On-demand
 * admin analytics — a full-purview pull is hundreds of employee-range
 * computations, hence the page's 300s ceiling.
 */
export async function computeRangeOverview(
  supabase: SupabaseServerClient,
  stores: StoreRef[],
  rangeStart: string,
  rangeEnd: string
): Promise<OverviewMetricsResult> {
  const { data: employees, error } = await supabase
    .from("employees")
    .select("id, location_id")
    .eq("active", true)
    .in(
      "location_id",
      stores.map((s) => s.id)
    );
  if (error) {
    console.error("[overview] employees fetch failed", { message: error.message });
  }

  const jobs = (employees ?? []).map((e) => ({
    employee_id: e.id as string,
    location_id: e.location_id as string,
  }));
  const samplesByStore = new Map<string, MetricSample[]>();
  const queue = [...jobs];

  async function worker() {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const computed = await computeMetricsForRange(
        supabase,
        job.employee_id,
        job.location_id,
        rangeStart,
        rangeEnd
      );
      if (!computed.ok) {
        console.warn("[overview] range compute failed", {
          employee_id: job.employee_id,
          error: computed.error,
        });
        continue;
      }
      const m = computed.metrics;
      const sample: MetricSample = {
        customer_service_rating: m.customer_service_rating,
        attendance_pct: m.attendance_pct,
        on_time_grace_pct: m.on_time_grace_pct,
        survey_engagement_pct: m.survey_engagement_pct,
        avg_task_list_completion_pct: m.avg_task_list_completion_pct,
        tattle_rating: m.tattle_rating,
      };
      const list = samplesByStore.get(job.location_id) ?? [];
      list.push(sample);
      samplesByStore.set(job.location_id, list);
    }
  }
  await Promise.all(
    Array.from({ length: RANGE_CONCURRENCY }, () => worker())
  );
  return assemble(stores, samplesByStore);
}
