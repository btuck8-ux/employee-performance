import type {
  ExpectationLabel,
  FixedMetricKey,
  ThresholdedMetricKey,
} from "./types";

/**
 * Classification for fixed-rule metrics. Boundaries are explicit `[lower, upper]`
 * inclusive on the upper end of the Meets band.
 *
 *  - On Time %      : <90 Below, [90,95] Meets, >95 Exceeds
 *  - Attendance %   : <95 Below, [95,100] Meets, >100 Exceeds  (legacy >100 branch kept)
 *  - Survey Eng. %  : <80 Below, [80,85] Meets, >85 Exceeds
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
      if (value <= 85) return "Meets Expectations";
      return "Exceeds Expectations";
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
