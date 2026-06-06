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
  recomputed: number;
  failures: string[];
}

/**
 * Run a worker pool over (employee × quarter) recompute jobs — the same
 * idempotent path the manual CSV importers use. Weights are fetched once and
 * threaded through so we don't re-read the singleton config per job.
 */
export async function runRecomputeJobs(
  supabase: AdminClient,
  locationId: string,
  jobs: RecomputeJob[]
): Promise<RecomputeResult> {
  const result: RecomputeResult = { recomputed: 0, failures: [] };
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
        { csWeights, tisWeights }
      );
      if (r.ok) result.recomputed += 1;
      else result.failures.push(`recompute ${job.employee_id} ${job.year}-Q${job.quarter}: ${r.error}`);
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
