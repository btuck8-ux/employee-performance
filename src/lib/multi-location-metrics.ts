/**
 * Multi-location combined metrics — the PURE math for the employee-profile
 * combined view (2026-08-23 sprint §4-B). No imports, no I/O: this module is
 * shared across the server page (which assembles per-location inputs) and
 * the client card (which recombines when the operator changes the location
 * subset), so it must stay free of server-only and client-only code.
 *
 * ⚠️ THE BUILD RULE (§4-B3): combined rates are recomputed from summed
 * numerators and denominators, NEVER averaged. 50% (2 of 4) + 100%
 * (18 of 18) is 20 of 22 = 90.9%, not 75%. Means are combined by summing
 * (sum, n) parts — the n is the metric's own non-null denominator (the
 * §4-B6 finding: tattle sub-scores and the review rating average over the
 * surveys/reviews where that value is non-null, so weighting stored
 * averages by tattle_quantity/review_quantity is subtly wrong; the parts
 * carry the true denominators instead).
 *
 * Null discipline (§4-B7): null means "not computable", never 0. A combined
 * value is null ONLY when every contributing denominator is zero; one
 * location with data and one without yields the one location's number.
 *
 * `avg_task_list_completion_pct` is NOT combinable from stored data
 * (§4-B5): the per-list count behind the mean is not stored, and
 * tasks_completed / tasks_accountable is a different ratio wearing the same
 * label. It renders per-location only; the combined column shows "—".
 */

/** A rate: percentage = num/den × 100 when den > 0. Sums across locations. */
export interface RatioParts {
  num: number;
  den: number;
}

/** A mean: value = sum/n when n > 0. n is the metric's own non-null count. */
export interface MeanParts {
  sum: number;
  n: number;
}

/** One location's combinable inputs for one quarter. */
export interface LocationQuarterMetrics {
  employeeId: string;
  quarterId: string;
  /** attended / scheduled (counts already capped per-location). */
  attendance: RatioParts;
  /** on-time / attended (strict). */
  onTime: RatioParts;
  /** on-time-with-grace / attended. */
  onTimeGrace: RatioParts;
  /** surveys completed / assigned. */
  surveyEngagement: RatioParts;
  csRating: MeanParts;
  tattleRating: MeanParts;
  tattleFood: MeanParts;
  tattleAccuracy: MeanParts;
  tattleSpeed: MeanParts;
  tattleQuantity: number;
  reviewQuantity: number;
  /** Per-location display only — never combined (§4-B5). */
  avgTaskListCompletionPct: number | null;
}

export interface CombinedQuarterMetrics {
  attendance_pct: number | null;
  on_time_pct: number | null;
  on_time_grace_pct: number | null;
  survey_engagement_pct: number | null;
  customer_service_rating: number | null;
  tattle_rating: number | null;
  tattle_score_food_quality: number | null;
  tattle_score_accuracy: number | null;
  tattle_score_speed_of_service: number | null;
  tattle_quantity: number;
  customer_review_quantity: number;
  scheduled_count: number;
  attended_count: number;
  surveys_assigned: number;
  surveys_completed: number;
}

function combineRatio(parts: RatioParts[]): {
  pct: number | null;
  num: number;
  den: number;
} {
  let num = 0;
  let den = 0;
  for (const p of parts) {
    num += p.num;
    den += p.den;
  }
  return { pct: den > 0 ? (num / den) * 100 : null, num, den };
}

function combineMean(parts: MeanParts[]): number | null {
  let sum = 0;
  let n = 0;
  for (const p of parts) {
    sum += p.sum;
    n += p.n;
  }
  return n > 0 ? sum / n : null;
}

/**
 * Combine any subset of a person's per-location quarter metrics. Order and
 * subset size don't matter; an empty subset yields all-null/zero.
 */
export function combineQuarterMetrics(
  subset: LocationQuarterMetrics[]
): CombinedQuarterMetrics {
  const attendance = combineRatio(subset.map((s) => s.attendance));
  const onTime = combineRatio(subset.map((s) => s.onTime));
  const onTimeGrace = combineRatio(subset.map((s) => s.onTimeGrace));
  const survey = combineRatio(subset.map((s) => s.surveyEngagement));
  return {
    attendance_pct: attendance.pct,
    on_time_pct: onTime.pct,
    on_time_grace_pct: onTimeGrace.pct,
    survey_engagement_pct: survey.pct,
    customer_service_rating: combineMean(subset.map((s) => s.csRating)),
    tattle_rating: combineMean(subset.map((s) => s.tattleRating)),
    tattle_score_food_quality: combineMean(subset.map((s) => s.tattleFood)),
    tattle_score_accuracy: combineMean(subset.map((s) => s.tattleAccuracy)),
    tattle_score_speed_of_service: combineMean(
      subset.map((s) => s.tattleSpeed)
    ),
    tattle_quantity: subset.reduce((a, s) => a + s.tattleQuantity, 0),
    customer_review_quantity: subset.reduce((a, s) => a + s.reviewQuantity, 0),
    scheduled_count: attendance.den,
    attended_count: attendance.num,
    surveys_assigned: survey.den,
    surveys_completed: survey.num,
  };
}

/** Build (sum, n) parts from raw per-item values, skipping nulls. */
export function meanPartsFromValues(
  values: Array<number | null>
): MeanParts {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v === null || Number.isNaN(v)) continue;
    sum += v;
    n += 1;
  }
  return { sum, n };
}
