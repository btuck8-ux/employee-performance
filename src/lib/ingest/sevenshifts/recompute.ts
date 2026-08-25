import { recomputePerformanceForQuarter } from "@/lib/performance-recompute";
import { fetchCustomerServiceWeights } from "@/lib/customer-service-score";
import { fetchTotalImpactWeights } from "@/lib/total-impact-score";
import { quarterOfDate, type Quarter } from "@/lib/quarter";
import type { AdminClient } from "./crosswalk";

/** A single (employee, quarter) recompute job. */
export interface RecomputeJob {
  employee_id: string;
  year: number;
  quarter: Quarter;
}

const RECOMPUTE_CONCURRENCY = 6;

/** Derive the (year, quarter) for a YYYY-MM-DD date string. */
export function quarterForDate(isoDate: string): { year: number; quarter: Quarter } {
  return quarterOfDate(new Date(isoDate.slice(0, 10) + "T12:00:00"));
}

export interface RecomputeResult {
  /** Rows actually written (created + updated) — NOT jobs run. */
  recomputed: number;
  created: number;
  updated: number;
  /** No-conjuring skips (§3): no existing row + no activity = no write. */
  skipped_no_activity: number;
  failures: string[];
}

/**
 * Run a worker pool over (employee × quarter) recompute jobs — the same
 * idempotent path the manual CSV importers use. Weights are fetched once and
 * threaded through so we don't re-read the singleton config per job.
 *
 * A job targeting a frozen period (report_periods.frozen, mig 063) fails
 * into `failures` and the pool keeps going — pass opts.allowFrozenQuarter
 * naming the exact quarter ("Q4-2025") to authorize a frozen-period write.
 */
export async function runRecomputeJobs(
  supabase: AdminClient,
  locationId: string,
  jobs: RecomputeJob[],
  opts?: { allowFrozenQuarter?: string }
): Promise<RecomputeResult> {
  const result: RecomputeResult = {
    recomputed: 0,
    created: 0,
    updated: 0,
    skipped_no_activity: 0,
    failures: [],
  };
  if (jobs.length === 0) return result;

  const csWeights = await fetchCustomerServiceWeights(supabase);
  const tisWeights = await fetchTotalImpactWeights(supabase);

  const queue = [...jobs];
  async function worker() {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const r = await recomputePerformanceForQuarter(
        supabase,
        job.employee_id,
        locationId,
        job.year,
        job.quarter,
        { csWeights, tisWeights, allowFrozenQuarter: opts?.allowFrozenQuarter }
      );
      if (!r.ok) {
        result.failures.push(`recompute ${job.employee_id} ${job.year}-Q${job.quarter}: ${r.error}`);
      } else if (r.action === "skipped_no_activity") {
        result.skipped_no_activity += 1;
      } else {
        result.recomputed += 1;
        if (r.action === "created") result.created += 1;
        else result.updated += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: RECOMPUTE_CONCURRENCY }, worker));
  return result;
}

/**
 * Rebuild the co-presence team tip-impact slice for each affected quarter.
 * Adding sales/time shifts the location baseline, which propagates to every
 * team's delta — so the whole (location, quarter) slice is rebuilt. Mirrors
 * the POS importer. One SQL call per quarter; idempotent.
 */
export async function recomputeTeamTipImpact(
  supabase: AdminClient,
  locationId: string,
  quarters: Array<{ year: number; quarter: Quarter }>,
  failures: string[]
): Promise<number> {
  let teamsRecomputed = 0;
  for (const { year, quarter } of quarters) {
    const { data: period } = await supabase
      .from("report_periods")
      .select("id")
      .eq("year", year)
      .eq("quarter", quarter)
      .maybeSingle();
    if (!period?.id) continue;
    const { data: teamCount, error: teamErr } = await supabase.rpc(
      "recompute_team_tip_impact",
      { p_location_id: locationId, p_report_period_id: period.id as string }
    );
    if (teamErr) failures.push(`team aggregation ${year}-Q${quarter}: ${teamErr.message}`);
    else if (typeof teamCount === "number") teamsRecomputed += teamCount;
  }
  return teamsRecomputed;
}

/** Collect the distinct (year, quarter) set from a list of YYYY-MM-DD dates. */
export function distinctQuarters(
  isoDates: string[]
): Array<{ year: number; quarter: Quarter }> {
  const map = new Map<string, { year: number; quarter: Quarter }>();
  for (const d of isoDates) {
    const q = quarterForDate(d);
    map.set(`${q.year}-Q${q.quarter}`, q);
  }
  return Array.from(map.values());
}

export interface SalesRecomputeSummary {
  quarters: Array<{ year: number; quarter: Quarter }>;
  recomputed: number;
  created: number;
  updated: number;
  skipped_no_activity: number;
  teams_recomputed: number;
  failures: string[];
}

/**
 * The shared recompute tail every sales writer runs after upserting
 * sales_records: refresh EVERY active employee at the location for each
 * touched quarter, then rebuild the team tip-impact slice per quarter.
 *
 * Why everyone-at-location and not just employees whose presence overlaps the
 * new sales: adding sales shifts the LOCATION baseline (location_tip_rate_pct,
 * location_tip_per_hour), which changes every employee's tip_rate_delta_pp —
 * a sale rung during nobody's shift still touches every quarter row.
 *
 * Callers: the manual POS CSV upload (upload-pos-actions.ts), the 7shifts
 * pos_receipts feed (receipts.ts), and the Toast sales feed (ingest/toast).
 * One tail, three writers — do not fork this logic per feed.
 */
export async function recomputeAfterSalesUpsert(
  supabase: AdminClient,
  locationId: string,
  transactionAts: string[]
): Promise<SalesRecomputeSummary> {
  const quarters = distinctQuarters(transactionAts);
  const summary: SalesRecomputeSummary = {
    quarters,
    recomputed: 0,
    created: 0,
    updated: 0,
    skipped_no_activity: 0,
    teams_recomputed: 0,
    failures: [],
  };
  if (quarters.length === 0) return summary;

  const { data: activeEmps } = await supabase
    .from("employees")
    .select("id")
    .eq("location_id", locationId)
    .eq("active", true);
  const employeeIds = ((activeEmps ?? []) as Array<{ id: string }>).map((e) => e.id);

  const jobs: RecomputeJob[] = [];
  for (const q of quarters) {
    for (const employee_id of employeeIds) {
      jobs.push({ employee_id, year: q.year, quarter: q.quarter });
    }
  }

  const rc = await runRecomputeJobs(supabase, locationId, jobs);
  summary.recomputed = rc.recomputed;
  summary.created = rc.created;
  summary.updated = rc.updated;
  summary.skipped_no_activity = rc.skipped_no_activity;
  summary.failures.push(...rc.failures);
  summary.teams_recomputed = await recomputeTeamTipImpact(
    supabase,
    locationId,
    quarters,
    summary.failures
  );
  return summary;
}
