"use server";

/**
 * Phase 10 — server actions for the Total Impact Score tile + drilldown on
 * the employee detail page.
 *
 * Two actions:
 *   - `fetchTisRangeSnapshotAction`: per-employee TIS over an arbitrary range.
 *     For quarter mode, reads the persisted row from performance_records (no
 *     compute). For all-time / custom range, calls computeMetricsForRange so
 *     the breakdown matches the canonical math.
 *   - `fetchTisRanksForEmployeeAction`: per-employee 3-rank lookup. Quarter
 *     mode uses the SQL `compute_tis_rankings_for_quarter` function; non-
 *     quarter mode falls back to per-employee compute across the population
 *     (slow — gated as an "open item" in the spec; profile after v1).
 */
import { createClient } from "@/lib/supabase/server";
import { computeMetricsForRange } from "@/lib/performance-recompute";
import {
  computeTotalImpactScoreBreakdown,
  fetchAllTimeWorkedHours,
  fetchTotalImpactWeights,
  isEligibleForRanking,
  TIS_ELIGIBILITY_MIN_HOURS,
  type TotalImpactScoreBreakdown,
  type TotalImpactWeights,
} from "@/lib/total-impact-score";

/** Worker-pool concurrency for per-employee range compute (matches POS / Phase 9 paths). */
const RANGE_COMPUTE_CONCURRENCY = 6;

export interface TisRangeSnapshot {
  composite_score: number | null;
  components_count: number;
  breakdown: TotalImpactScoreBreakdown;
  // Native component context for the drilldown rendering
  cs_score: number | null;
  cs_components_count: number | null;
  attendance_pct: number | null;
  on_time_grace_pct: number | null;
  avg_task_list_completion_pct: number | null;
  survey_engagement_pct: number | null;
  weights: TotalImpactWeights;
}

export interface TisRanks {
  eligible: boolean;
  hours_worked: number;
  hours_required: number;
  location_rank: number | null;
  location_total: number;
  client_rank: number | null;
  client_total: number;
  platform_rank: number | null;
  platform_total: number;
}

function toNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Snapshot the TIS composite + per-component values for one employee over a
 * window. For quarter mode the caller passes the report_period_id; we read
 * the persisted row. For other modes we recompute from raw via
 * computeMetricsForRange.
 */
export async function fetchTisRangeSnapshotAction(
  employee_id: string,
  location_id: string,
  mode: "quarter" | "all_time" | "custom",
  start_date: string,
  end_date: string,
  quarter_id?: string
): Promise<TisRangeSnapshot> {
  const supabase = await createClient();
  const weights = await fetchTotalImpactWeights(supabase);

  if (mode === "quarter" && quarter_id) {
    const { data } = await supabase
      .from("performance_records")
      .select(
        "customer_service_score, customer_service_score_components_count, attendance_pct, on_time_grace_pct, avg_task_list_completion_pct, survey_engagement_pct, total_impact_score, total_impact_score_components_count"
      )
      .eq("employee_id", employee_id)
      .eq("location_id", location_id)
      .eq("report_period_id", quarter_id)
      .maybeSingle();

    const cs = toNum(data?.customer_service_score ?? null);
    const att = toNum(data?.attendance_pct ?? null);
    const on = toNum(data?.on_time_grace_pct ?? null);
    const tasks = toNum(data?.avg_task_list_completion_pct ?? null);
    const survey = toNum(data?.survey_engagement_pct ?? null);
    const breakdown = computeTotalImpactScoreBreakdown(cs, att, on, tasks, survey, weights);

    return {
      composite_score: breakdown.composite_score,
      components_count: breakdown.components_count,
      breakdown,
      cs_score: cs,
      cs_components_count: (data?.customer_service_score_components_count as number | null) ?? null,
      attendance_pct: att,
      on_time_grace_pct: on,
      avg_task_list_completion_pct: tasks,
      survey_engagement_pct: survey,
      weights,
    };
  }

  // Non-quarter: recompute from raw over the window.
  const computed = await computeMetricsForRange(
    supabase,
    employee_id,
    location_id,
    start_date,
    end_date,
    { tisWeights: weights }
  );
  if (!computed.ok) {
    // Defensive: surface a "no data" snapshot rather than throwing — keeps the
    // tile rendering smoothly even when computeMetricsForRange returns an
    // unexpected error.
    const breakdown = computeTotalImpactScoreBreakdown(null, null, null, null, null, weights);
    return {
      composite_score: null,
      components_count: 0,
      breakdown,
      cs_score: null,
      cs_components_count: null,
      attendance_pct: null,
      on_time_grace_pct: null,
      avg_task_list_completion_pct: null,
      survey_engagement_pct: null,
      weights,
    };
  }
  const m = computed.metrics;
  return {
    composite_score: m.total_impact_score,
    components_count: m.total_impact_score_components_count,
    breakdown: m.total_impact_score_breakdown,
    cs_score: m.customer_service_score,
    cs_components_count: m.customer_service_score_components_count,
    attendance_pct: m.attendance_pct,
    on_time_grace_pct: m.on_time_grace_pct,
    avg_task_list_completion_pct: m.avg_task_list_completion_pct,
    survey_engagement_pct: m.survey_engagement_pct,
    weights,
  };
}

/**
 * Three ranks (location/client/platform) for one employee at one range.
 * Quarter mode hits a single SQL window function. Non-quarter mode falls
 * back to per-employee compute across the population — spec acknowledges
 * this is slow at v1 scale and gates further optimization to after launch.
 */
export async function fetchTisRanksForEmployeeAction(
  employee_id: string,
  location_id: string,
  mode: "quarter" | "all_time" | "custom",
  start_date: string,
  end_date: string,
  quarter_id?: string
): Promise<TisRanks> {
  const supabase = await createClient();

  // Eligibility is range-independent (uses all-time hours). Always compute.
  const { data: emp } = await supabase
    .from("employees")
    .select("active, locations(client_id)")
    .eq("id", employee_id)
    .maybeSingle();
  const active = (emp?.active as boolean | null) ?? false;
  const client_id =
    ((emp?.locations as unknown as { client_id: string } | null)?.client_id) ?? null;
  const hours_worked = await fetchAllTimeWorkedHours(supabase, employee_id, location_id);
  const eligible = isEligibleForRanking(active, hours_worked);

  const emptyRanks: TisRanks = {
    eligible,
    hours_worked,
    hours_required: TIS_ELIGIBILITY_MIN_HOURS,
    location_rank: null,
    location_total: 0,
    client_rank: null,
    client_total: 0,
    platform_rank: null,
    platform_total: 0,
  };

  if (!eligible) return emptyRanks;

  if (mode === "quarter" && quarter_id) {
    const { data, error } = await supabase.rpc("compute_tis_rankings_for_quarter", {
      p_report_period_id: quarter_id,
    });
    if (error) {
      console.error("[tis-ranks] quarter RPC failed:", error.message);
      return emptyRanks;
    }
    type Row = {
      employee_id: string;
      location_rank: number | null;
      location_total: number;
      client_rank: number | null;
      client_total: number;
      platform_rank: number | null;
      platform_total: number;
    };
    const rows = (data ?? []) as Row[];
    const me = rows.find((r) => r.employee_id === employee_id);
    if (!me) return emptyRanks;
    return {
      eligible,
      hours_worked,
      hours_required: TIS_ELIGIBILITY_MIN_HOURS,
      location_rank: me.location_rank,
      location_total: me.location_total,
      client_rank: me.client_rank,
      client_total: me.client_total,
      platform_rank: me.platform_rank,
      platform_total: me.platform_total,
    };
  }

  // Non-quarter: per-employee compute across the eligible platform pool.
  return rankByRangeCompute(
    supabase,
    employee_id,
    location_id,
    client_id,
    start_date,
    end_date,
    hours_worked,
    eligible
  );
}

/**
 * Compute TIS for every eligible employee in the platform over the given
 * range, then derive the three ranks for the requested employee. Worker
 * pool of 6 (matches POS recompute) to keep the round-trip count tolerable.
 *
 * Performance budget gate: spec acknowledges this is slow at platform scale
 * (50+ employees) for arbitrary ranges and gates optimization to after v1.
 */
async function rankByRangeCompute(
  supabase: Awaited<ReturnType<typeof createClient>>,
  employee_id: string,
  location_id: string,
  client_id: string | null,
  start_date: string,
  end_date: string,
  myHoursWorked: number,
  myEligible: boolean
): Promise<TisRanks> {
  // Pull every active employee with their location + client. Range-compute
  // each one's TIS; non-eligible drop out.
  const { data: empRows } = await supabase
    .from("employees")
    .select("id, location_id, active, locations!inner(client_id)")
    .eq("active", true);

  type EmpRow = {
    id: string;
    location_id: string;
    active: boolean;
    locations: { client_id: string } | null;
  };
  const allEmps = ((empRows ?? []) as unknown as EmpRow[]).filter((e) => e.active);

  const tisWeights = await fetchTotalImpactWeights(supabase);

  type Scored = {
    employee_id: string;
    location_id: string;
    client_id: string | null;
    tis: number | null;
  };

  const queue: EmpRow[] = [...allEmps];
  const scored: Scored[] = [];

  async function worker() {
    for (;;) {
      const e = queue.shift();
      if (!e) return;
      const hours = await fetchAllTimeWorkedHours(supabase, e.id, e.location_id);
      if (!isEligibleForRanking(e.active, hours)) {
        // Skip ineligible — they don't count toward rank totals or positions.
        continue;
      }
      const m = await computeMetricsForRange(
        supabase,
        e.id,
        e.location_id,
        start_date,
        end_date,
        { tisWeights }
      );
      if (!m.ok) continue;
      scored.push({
        employee_id: e.id,
        location_id: e.location_id,
        client_id: e.locations?.client_id ?? null,
        tis: m.metrics.total_impact_score,
      });
    }
  }
  await Promise.all(
    Array.from({ length: RANGE_COMPUTE_CONCURRENCY }, () => worker())
  );

  const rankAll = (pool: Scored[]): { rank: number; total: number } => {
    const withTis = pool.filter((s) => s.tis !== null) as Array<Scored & { tis: number }>;
    if (withTis.length === 0) return { rank: 0, total: 0 };
    // Competition ranking: same TIS shares rank.
    const sorted = [...withTis].sort((a, b) => b.tis - a.tis);
    let rank = 0;
    let lastScore = Number.POSITIVE_INFINITY;
    let position = 0;
    for (const s of sorted) {
      position += 1;
      if (s.tis < lastScore) {
        rank = position;
        lastScore = s.tis;
      }
      if (s.employee_id === employee_id) {
        return { rank, total: withTis.length };
      }
    }
    return { rank: 0, total: withTis.length };
  };

  const me = scored.find((s) => s.employee_id === employee_id);
  if (!me || me.tis === null || !myEligible) {
    // We were ineligible OR the range produced a null composite — return
    // totals from the population but no rank for us.
    const locTotal = scored.filter((s) => s.location_id === location_id && s.tis !== null).length;
    const cliTotal = scored.filter((s) => s.client_id === client_id && s.tis !== null).length;
    const platTotal = scored.filter((s) => s.tis !== null).length;
    return {
      eligible: myEligible,
      hours_worked: myHoursWorked,
      hours_required: TIS_ELIGIBILITY_MIN_HOURS,
      location_rank: null,
      location_total: locTotal,
      client_rank: null,
      client_total: cliTotal,
      platform_rank: null,
      platform_total: platTotal,
    };
  }

  const loc = rankAll(scored.filter((s) => s.location_id === location_id));
  const cli = rankAll(scored.filter((s) => s.client_id === client_id));
  const plat = rankAll(scored);

  return {
    eligible: myEligible,
    hours_worked: myHoursWorked,
    hours_required: TIS_ELIGIBILITY_MIN_HOURS,
    location_rank: loc.rank > 0 ? loc.rank : null,
    location_total: loc.total,
    client_rank: cli.rank > 0 ? cli.rank : null,
    client_total: cli.total,
    platform_rank: plat.rank > 0 ? plat.rank : null,
    platform_total: plat.total,
  };
}
