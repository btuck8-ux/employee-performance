import type {
  ExpectationLabel,
  FixedMetricKey,
  ThresholdedMetricKey,
} from "./types";

/**
 * Classification for fixed-rule metrics. The thresholds below are interim —
 * we'll move them to a per-location settings UI later.
 *
 *  - On Time %                 : <90 Below, [90,95] Meets, >95 Exceeds
 *  - Attendance %              : <95 Below, [95,100] Meets, >100 Exceeds (legacy >100 branch kept)
 *  - Survey Engagement %       : <80 Below, [80,85) Meets, >=85 Exceeds
 *  - Tattle Rating             : <4.25 Below, >=4.25 Meets
 *  - Tattle Score Food Quality : <90 Below, >=90 Meets
 *  - Tattle Score Accuracy     : <90 Below, >=90 Meets
 *  - Tattle Score Speed        : <90 Below, >=90 Meets
 *  - Customer Service Rating   : <4.25 Below, >=4.25 Meets
 *
 * Tattle and customer-service metrics remain two-tier (Below / Meets) for now;
 * they'll get an Exceeds tier when we set thresholds for it.
 */
export function classifyFixed(
  metric: FixedMetricKey,
  value: number | null | undefined
): ExpectationLabel | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  switch (metric) {
    case "on_time_pct":
      if (value < 90) return "Below Expectations";
      if (value <= 95) return "Meets Expectations";
      return "Exceeds Expectations";
    case "attendance_pct":
      if (value < 95) return "Below Expectations";
      if (value <= 100) return "Meets Expectations";
      return "Exceeds Expectations";
    case "survey_engagement_pct":
      if (value < 80) return "Below Expectations";
      if (value < 85) return "Meets Expectations";
      return "Exceeds Expectations";
    case "tattle_rating":
    case "customer_service_rating":
      return value >= 4.25 ? "Meets Expectations" : "Below Expectations";
    case "tattle_score_food_quality":
    case "tattle_score_accuracy":
    case "tattle_score_speed_of_service":
      return value >= 90 ? "Meets Expectations" : "Below Expectations";
  }
}

/**
 * Classification for threshold-driven metrics (ratings).
 * If thresholds are missing, returns null.
 */
export function classifyThresholded(
  value: number | null | undefined,
  thresholds: { good_min: number; needs_min: number } | null | undefined
): ExpectationLabel | null {
  if (
    value === null ||
    value === undefined ||
    Number.isNaN(value) ||
    !thresholds
  )
    return null;
  if (value >= thresholds.good_min) return "Exceeds Expectations";
  if (value >= thresholds.needs_min) return "Meets Expectations";
  return "Below Expectations";
}

export type ThresholdMap = Partial<
  Record<ThresholdedMetricKey, { good_min: number; needs_min: number }>
>;
