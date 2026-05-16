"use server";

/**
 * Phase 10 — server action backing the rankings page.
 *
 * Quarter mode hits the SQL `compute_tis_rankings_for_quarter` function and
 * filters to the requested scope in TS. Non-quarter mode iterates every
 * active employee in scope, runs computeMetricsForRange per employee, then
 * computes ranks in-memory (concurrency 6). Spec acknowledges the non-
 * quarter path is slow at platform scale and gates optimization to after v1.
 */
import { createClient } from "@/lib/supabase/server";
import { computeMetricsForRange } from "@/lib/performance-recompute";
import {
  fetchAllTimeWorkedHours,
  fetchTotalImpactWeights,
  isEligibleForRanking,
  TIS_ELIGIBILITY_MIN_HOURS,
} from "@/lib/total-impact-score";

const RANGE_COMPUTE_CONCURRENCY = 6;

export type RankingScope = "location" | "client" | "platform";

export interface RankingRow {
  employee_id: string;
  employee_name: string;
  location_id: string;
  location_name: string;
  client_id: string;
  client_name: string;
  active: boolean;
  total_impact_score: number | null;
  components_count: number;
  all_time_hours_worked: number;
  eligible: boolean;
  /** Rank within the scope the caller requested (location / client / platform). */
  scope_rank: number | null;
  scope_total: number;
  /** Companion ranks always present so the row can drill into the employee detail page. */
  location_rank: number | null;
  location_total: number;
  client_rank: number | null;
  client_total: number;
  platform_rank: number | null;
  platform_total: number;
}

/**
 * For quarter mode: scope_id matches the chosen scope (location_id / client_id);
 * ignored for platform. Quarter id must be present.
 * For non-quarter modes: scope_id filters which employees to iterate.
 */
export async function fetchRankingsAction(params: {
  mode: "quarter" | "all_time" | "custom";
  scope: RankingScope;
  /** location_id (scope=location) | client_id (scope=client) | null (scope=platform). */
  scope_id: string | null;
  start_date: string;
  end_date: string;
  quarter_id?: string;
}): Promise<{ ok: true; rows: RankingRow[] } | { ok: false; error: string }> {
  const supabase = await createClient();

  if (params.mode === "quarter") {
    if (!params.quarter_id) {
      return { ok: false, error: "Quarter mode requires a quarter id." };
    }
    const { data, error } = await supabase.rpc("compute_tis_rankings_for_quarter", {
      p_report_period_id: params.quarter_id,
    });
    if (error) return { ok: false, error: error.message };
    type Row = {
      employee_id: string;
      employee_name: string;
      location_id: string;
      location_name: string;
      client_id: string;
      client_name: string;
      active: boolean;
      total_impact_score: number | string | null;
      components_count: number | null;
      all_time_hours_worked: number | string | null;
      eligible: boolean;
      location_rank: number | null;
      location_total: number | null;
      client_rank: number | null;
      client_total: number | null;
      platform_rank: number | null;
      platform_total: number | null;
    };
    const toNum = (v: number | string | null | undefined): number | null => {
      if (v === null || v === undefined) return null;
      const n = typeof v === "string" ? Number(v) : v;
      return Number.isFinite(n) ? n : null;
    };

    let rows = ((data ?? []) as Row[]).map((r) => {
      const scope_rank =
        params.scope === "location"
          ? r.location_rank
          : params.scope === "client"
            ? r.client_rank
            : r.platform_rank;
      const scope_total =
        params.scope === "location"
          ? (r.location_total ?? 0)
          : params.scope === "client"
            ? (r.client_total ?? 0)
            : (r.platform_total ?? 0);
      return {
        employee_id: r.employee_id,
        employee_name: r.employee_name,
        location_id: r.location_id,
        location_name: r.location_name,
        client_id: r.client_id,
        client_name: r.client_name,
        active: r.active,
        total_impact_score: toNum(r.total_impact_score),
        components_count: r.components_count ?? 0,
        all_time_hours_worked: toNum(r.all_time_hours_worked) ?? 0,
        eligible: r.eligible,
        scope_rank,
        scope_total,
        location_rank: r.location_rank,
        location_total: r.location_total ?? 0,
        client_rank: r.client_rank,
        client_total: r.client_total ?? 0,
        platform_rank: r.platform_rank,
        platform_total: r.platform_total ?? 0,
      } as RankingRow;
    });

    if (params.scope === "location" && params.scope_id) {
      rows = rows.filter((r) => r.location_id === params.scope_id);
    } else if (params.scope === "client" && params.scope_id) {
      rows = rows.filter((r) => r.client_id === params.scope_id);
    }

    return { ok: true, rows };
  }

  // Non-quarter mode: iterate employees in scope and compute TIS per range.
  let empQuery = supabase
    .from("employees")
    .select("id, employee_name, location_id, active, locations!inner(id, name, client_id, clients!inner(id, name))");
  if (params.scope === "location" && params.scope_id) {
    empQuery = empQuery.eq("location_id", params.scope_id);
  } else if (params.scope === "client" && params.scope_id) {
    empQuery = empQuery.eq("locations.client_id", params.scope_id);
  }
  const { data: empRows, error: empErr } = await empQuery;
  if (empErr) return { ok: false, error: empErr.message };

  type EmpRow = {
    id: string;
    employee_name: string;
    location_id: string;
    active: boolean;
    locations: {
      id: string;
      name: string;
      client_id: string;
      clients: { id: string; name: string } | null;
    } | null;
  };
  const emps = ((empRows ?? []) as unknown as EmpRow[]).filter((e) => e.locations);

  const tisWeights = await fetchTotalImpactWeights(supabase);

  type Scored = {
    employee_id: string;
    employee_name: string;
    location_id: string;
    location_name: string;
    client_id: string;
    client_name: string;
    active: boolean;
    total_impact_score: number | null;
    components_count: number;
    all_time_hours_worked: number;
    eligible: boolean;
  };

  const queue: EmpRow[] = [...emps];
  const scored: Scored[] = [];
  async function worker() {
    for (;;) {
      const e = queue.shift();
      if (!e || !e.locations) return;
      const hours = await fetchAllTimeWorkedHours(supabase, e.id, e.location_id);
      const eligible = isEligibleForRanking(e.active, hours);
      let tis: number | null = null;
      let cnt = 0;
      // Skip the heavier compute for ineligible: we still show them in
      // the "show ineligible" view but their TIS isn't strictly needed for
      // ranking. Cheaper to mark them ineligible and render an em-dash.
      if (eligible) {
        const m = await computeMetricsForRange(
          supabase,
          e.id,
          e.location_id,
          params.start_date,
          params.end_date,
          { tisWeights }
        );
        if (m.ok) {
          tis = m.metrics.total_impact_score;
          cnt = m.metrics.total_impact_score_components_count;
        }
      }
      scored.push({
        employee_id: e.id,
        employee_name: e.employee_name,
        location_id: e.location_id,
        location_name: e.locations.name,
        client_id: e.locations.client_id,
        client_name: e.locations.clients?.name ?? "",
        active: e.active,
        total_impact_score: tis,
        components_count: cnt,
        all_time_hours_worked: hours,
        eligible,
      });
    }
  }
  await Promise.all(
    Array.from({ length: RANGE_COMPUTE_CONCURRENCY }, () => worker())
  );

  // Compute per-scope ranks. Three independent ranks so the row can show
  // them all in the table (location / client / platform). Companion totals
  // are scoped to the eligible+ranked pool of each scope.
  const ranked = computeRanksAll(scored);

  // Filter to the requested scope for the final returned set.
  let rows: RankingRow[] = ranked.map<RankingRow>((s) => {
    const scope_rank =
      params.scope === "location"
        ? s.location_rank
        : params.scope === "client"
          ? s.client_rank
          : s.platform_rank;
    const scope_total =
      params.scope === "location"
        ? s.location_total
        : params.scope === "client"
          ? s.client_total
          : s.platform_total;
    return { ...s, scope_rank, scope_total };
  });

  if (params.scope === "location" && params.scope_id) {
    rows = rows.filter((r) => r.location_id === params.scope_id);
  } else if (params.scope === "client" && params.scope_id) {
    rows = rows.filter((r) => r.client_id === params.scope_id);
  }

  return { ok: true, rows };
}

interface RankableInput {
  employee_id: string;
  employee_name: string;
  location_id: string;
  location_name: string;
  client_id: string;
  client_name: string;
  active: boolean;
  total_impact_score: number | null;
  components_count: number;
  all_time_hours_worked: number;
  eligible: boolean;
}

interface RankedRow extends RankableInput {
  location_rank: number | null;
  location_total: number;
  client_rank: number | null;
  client_total: number;
  platform_rank: number | null;
  platform_total: number;
}

/**
 * Competition-rank (1, 1, 3, 4) within each scope. Only employees who are
 * eligible AND have a non-null TIS enter the rank pool — ineligible / null
 * rows get rank=null and full-pool totals.
 */
function computeRanksAll(items: RankableInput[]): RankedRow[] {
  const pool = items.filter((i) => i.eligible && i.total_impact_score !== null);

  const ranksByScope = (key: (i: RankableInput) => string | null) => {
    const groups = new Map<string, RankableInput[]>();
    for (const it of pool) {
      const k = key(it);
      if (k === null) continue;
      const list = groups.get(k);
      if (list) list.push(it);
      else groups.set(k, [it]);
    }
    const ranks = new Map<string, { rank: number; total: number }>(); // by employee_id
    const totals = new Map<string, number>(); // by scope key
    for (const [k, list] of groups) {
      const sorted = [...list].sort(
        (a, b) => (b.total_impact_score ?? 0) - (a.total_impact_score ?? 0)
      );
      let rank = 0;
      let position = 0;
      let lastScore = Number.POSITIVE_INFINITY;
      for (const it of sorted) {
        position += 1;
        const s = it.total_impact_score ?? 0;
        if (s < lastScore) {
          rank = position;
          lastScore = s;
        }
        ranks.set(it.employee_id, { rank, total: list.length });
      }
      totals.set(k, list.length);
    }
    return { ranks, totals };
  };

  const loc = ranksByScope((i) => i.location_id);
  const cli = ranksByScope((i) => i.client_id);
  const plat = ranksByScope(() => "ALL");

  return items.map<RankedRow>((i) => {
    const lk = loc.ranks.get(i.employee_id);
    const ck = cli.ranks.get(i.employee_id);
    const pk = plat.ranks.get(i.employee_id);
    return {
      ...i,
      location_rank: lk?.rank ?? null,
      location_total: loc.totals.get(i.location_id) ?? 0,
      client_rank: ck?.rank ?? null,
      client_total: cli.totals.get(i.client_id) ?? 0,
      platform_rank: pk?.rank ?? null,
      platform_total: plat.totals.get("ALL") ?? 0,
    };
  });
}

/** Re-export the eligibility constant for client-side rendering. */
export async function getTisEligibilityMinHours(): Promise<number> {
  return TIS_ELIGIBILITY_MIN_HOURS;
}
