/**
 * Phase 10 — Total Impact Score math.
 *
 * Mirrors the SQL function in migration 025 (`compute_total_impact_score_breakdown`).
 * Source of truth for runtime / display; keep the two in lockstep when the
 * weighting or null-handling rules change.
 *
 * Spec: phase-10-total-impact-score-spec.md (locked 2026-05-16).
 *
 * The five inputs are already on a 0–100 scale on `performance_records`
 * (CS Score from Phase 9, and the four behavioral percent columns from
 * earlier phases). Defensive clamps to [0, 100] handle any stray values.
 *
 * Canonical column picks (do not relitigate — these are spec-locked):
 *   - `on_time_grace_pct`            (NOT `on_time_pct`): the grace-aware
 *                                    version is what dashboards surface and
 *                                    matches manager expectations.
 *   - `avg_task_list_completion_pct` (NOT `task_completion_pct` or
 *                                    `task_list_completion_pct`): the
 *                                    location-level list rollup smooths
 *                                    individual-task volatility and matches
 *                                    the PDF report's task line.
 *
 * Critical sub-rule: CS Score's single-source state (Phase 9 components_count
 * = 1) writes customer_service_score = NULL in Phase 9. So a non-null CS Score
 * here already encodes "real composite present"; we just null-check.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExpectationLabel } from "./types";

/** Threshold cutoffs (same as Phase 9 CS Score: ≥85 green, 70–<85 yellow, <70 red). */
export const TIS_GREEN_MIN = 85;
export const TIS_YELLOW_MIN = 70;

/** Minimum components required to produce a composite (4 of 5). */
export const TIS_MIN_COMPONENTS = 4;

/** All-time hours-worked tenure threshold for ranking eligibility. */
export const TIS_ELIGIBILITY_MIN_HOURS = 40;

export interface TotalImpactWeights {
  weight_cs_score: number;
  weight_attendance: number;
  weight_on_time: number;
  weight_tasks: number;
  weight_survey: number;
}

export const DEFAULT_TIS_WEIGHTS: TotalImpactWeights = {
  weight_cs_score: 0.4,
  weight_attendance: 0.15,
  weight_on_time: 0.15,
  weight_tasks: 0.15,
  weight_survey: 0.15,
};

export interface TotalImpactScoreBreakdown {
  /** 0–100 composite; null when fewer than 4 components are present. */
  composite_score: number | null;
  /** 0..5 — how many of the five components contributed. */
  components_count: 0 | 1 | 2 | 3 | 4 | 5;
  /** Per-component normalized 0–100 scores; null when the component is missing. */
  cs_component_score: number | null;
  attendance_component_score: number | null;
  on_time_component_score: number | null;
  tasks_component_score: number | null;
  survey_component_score: number | null;
  /** Effective (post re-weight) weights; null when component missing OR composite is null. */
  effective_weight_cs: number | null;
  effective_weight_attendance: number | null;
  effective_weight_on_time: number | null;
  effective_weight_tasks: number | null;
  effective_weight_survey: number | null;
}

function clamp01_100(x: number): number {
  if (x < 0) return 0;
  if (x > 100) return 100;
  return x;
}

/** Null-safe defensive clamp to [0, 100]. */
function normalize(x: number | null): number | null {
  if (x === null || !Number.isFinite(x)) return null;
  return clamp01_100(x);
}

/**
 * Compute the TIS composite + breakdown from native inputs and configured weights.
 * Pure function — mirrors SQL `compute_total_impact_score_breakdown`.
 *
 * Pass the CS Score composite (not the raw components_count) — a non-null
 * `csScore` already encodes "Phase 9 composite present" because Phase 9
 * writes NULL for single-source / no-data states.
 */
export function computeTotalImpactScoreBreakdown(
  csScore: number | null,
  attendancePct: number | null,
  onTimeGracePct: number | null,
  avgTaskListPct: number | null,
  surveyEngagementPct: number | null,
  weights: TotalImpactWeights
): TotalImpactScoreBreakdown {
  const cs = normalize(csScore);
  const att = normalize(attendancePct);
  const on = normalize(onTimeGracePct);
  const tasks = normalize(avgTaskListPct);
  const survey = normalize(surveyEngagementPct);

  const wCs = cs !== null ? weights.weight_cs_score : 0;
  const wAtt = att !== null ? weights.weight_attendance : 0;
  const wOn = on !== null ? weights.weight_on_time : 0;
  const wTasks = tasks !== null ? weights.weight_tasks : 0;
  const wSurvey = survey !== null ? weights.weight_survey : 0;
  const wSum = wCs + wAtt + wOn + wTasks + wSurvey;

  const cnt = ((cs !== null ? 1 : 0)
    + (att !== null ? 1 : 0)
    + (on !== null ? 1 : 0)
    + (tasks !== null ? 1 : 0)
    + (survey !== null ? 1 : 0)) as 0 | 1 | 2 | 3 | 4 | 5;

  if (cnt < TIS_MIN_COMPONENTS) {
    return {
      composite_score: null,
      components_count: cnt,
      cs_component_score: cs,
      attendance_component_score: att,
      on_time_component_score: on,
      tasks_component_score: tasks,
      survey_component_score: survey,
      effective_weight_cs: null,
      effective_weight_attendance: null,
      effective_weight_on_time: null,
      effective_weight_tasks: null,
      effective_weight_survey: null,
    };
  }

  if (wSum <= 0) {
    // Degenerate all-zero-weights config: composite 0 with null effective
    // weights, matching the deployed SQL (025, canonical — Tucker 2026-08-07).
    return {
      composite_score: 0,
      components_count: cnt,
      cs_component_score: cs,
      attendance_component_score: att,
      on_time_component_score: on,
      tasks_component_score: tasks,
      survey_component_score: survey,
      effective_weight_cs: null,
      effective_weight_attendance: null,
      effective_weight_on_time: null,
      effective_weight_tasks: null,
      effective_weight_survey: null,
    };
  }

  const ewCs = wCs / wSum;
  const ewAtt = wAtt / wSum;
  const ewOn = wOn / wSum;
  const ewTasks = wTasks / wSum;
  const ewSurvey = wSurvey / wSum;

  const composite =
    (cs !== null ? ewCs * cs : 0) +
    (att !== null ? ewAtt * att : 0) +
    (on !== null ? ewOn * on : 0) +
    (tasks !== null ? ewTasks * tasks : 0) +
    (survey !== null ? ewSurvey * survey : 0);

  return {
    composite_score: composite,
    components_count: cnt,
    cs_component_score: cs,
    attendance_component_score: att,
    on_time_component_score: on,
    tasks_component_score: tasks,
    survey_component_score: survey,
    effective_weight_cs: ewCs,
    effective_weight_attendance: ewAtt,
    effective_weight_on_time: ewOn,
    effective_weight_tasks: ewTasks,
    effective_weight_survey: ewSurvey,
  };
}

/**
 * Map a 0–100 score to the threshold band per spec.
 * ≥85 green, 70–<85 yellow, <70 red. Returns null when input is null.
 *
 * Reuses ExpectationLabel so callers can reuse <ExpectationBadge />.
 */
export function classifyTotalImpactScore(
  value: number | null
): ExpectationLabel | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value >= TIS_GREEN_MIN) return "Exceeds Expectations";
  if (value >= TIS_YELLOW_MIN) return "Meets Expectations";
  return "Below Expectations";
}

export type TisScoreTone = "green" | "yellow" | "red" | "muted";

export function toneForTotalImpactScore(value: number | null): TisScoreTone {
  if (value === null || !Number.isFinite(value)) return "muted";
  if (value >= TIS_GREEN_MIN) return "green";
  if (value >= TIS_YELLOW_MIN) return "yellow";
  return "red";
}

/** Display-rounded composite (whole numbers per spec). */
export function formatTotalImpactScore(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return Math.round(value).toString();
}

/**
 * Fetch the singleton weight config. Falls back to defaults if the row is
 * missing or unreadable — keeps the recompute path resilient. Defaults match
 * the migration's default row (0.40 / 0.15 × 4).
 */
export async function fetchTotalImpactWeights(
  supabase: SupabaseClient
): Promise<TotalImpactWeights> {
  const { data, error } = await supabase
    .from("total_impact_score_config")
    .select(
      "weight_cs_score, weight_attendance, weight_on_time, weight_tasks, weight_survey"
    )
    .limit(1)
    .maybeSingle();
  if (error || !data) return { ...DEFAULT_TIS_WEIGHTS };
  const toNum = (v: number | string | null | undefined, fallback: number) => {
    if (v === null || v === undefined) return fallback;
    const n = typeof v === "string" ? Number(v) : v;
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    weight_cs_score: toNum(data.weight_cs_score, DEFAULT_TIS_WEIGHTS.weight_cs_score),
    weight_attendance: toNum(data.weight_attendance, DEFAULT_TIS_WEIGHTS.weight_attendance),
    weight_on_time: toNum(data.weight_on_time, DEFAULT_TIS_WEIGHTS.weight_on_time),
    weight_tasks: toNum(data.weight_tasks, DEFAULT_TIS_WEIGHTS.weight_tasks),
    weight_survey: toNum(data.weight_survey, DEFAULT_TIS_WEIGHTS.weight_survey),
  };
}

/**
 * Sum of all worked hours at a location for tenure-proxy eligibility.
 * Eligibility rule: active = true AND all-time worked hours ≥ 40.
 *
 * Reads v_worked_intervals (mig 058) — the flip's single worked-time
 * source — whose `hours` column keeps the pay-bucket semantics on every
 * side (time_entries' four buckets; Toast punches' regular+overtime).
 * Reading the same view the SQL rankings function reads keeps TS↔SQL
 * parity by construction. Returns 0 when there are no worked intervals.
 */
export async function fetchAllTimeWorkedHours(
  supabase: SupabaseClient,
  employeeId: string,
  locationId: string
): Promise<number> {
  type Row = { hours: number | string | null };
  let total = 0;
  const PAGE = 1000;
  let from = 0;
  // PostgREST default cap is 1000; paginate to be safe — large stores can
  // easily have a few thousand worked entries across multiple years.
  for (;;) {
    const { data, error } = await supabase
      .from("v_worked_intervals")
      .select("hours")
      .eq("employee_id", employeeId)
      .eq("location_id", locationId)
      .range(from, from + PAGE - 1);
    if (error) break;
    const rows = (data ?? []) as Row[];
    for (const r of rows) {
      total +=
        r.hours === null || r.hours === undefined
          ? 0
          : typeof r.hours === "string"
            ? Number(r.hours) || 0
            : r.hours;
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return total;
}

/**
 * Eligibility check. Both conditions must hold for an employee to appear in
 * any ranking: active = true AND all-time worked hours ≥ 40 at this location.
 */
export interface TisEligibility {
  eligible: boolean;
  active: boolean;
  hours_worked: number;
  hours_required: number;
}

export function isEligibleForRanking(
  active: boolean,
  allTimeHoursWorked: number
): boolean {
  return active && allTimeHoursWorked >= TIS_ELIGIBILITY_MIN_HOURS;
}
