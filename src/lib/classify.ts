import type {
  ExpectationLabel,
  TargetLabel,
  TargetMetricKey,
  ThresholdedMetricKey,
} from "./types";

/**
 * Loaded `metric_targets` rows (mig 051), keyed by metric. Partial on
 * purpose: a missing key means "no target configured" and classification
 * fails VISIBLE (null → em-dash badge), never falls back to a hardcoded
 * number — same doctrine as classifyThresholded below.
 */
export type MetricTargets = Partial<Record<TargetMetricKey, number>>;

/**
 * Two-tier target evaluation for the nine target-driven metrics (2026-08-14
 * targets sprint; THQ contract memo §1). Replaces the old hardcoded
 * three-tier `classifyFixed` bands — a single target value can't honestly
 * drive three tiers, and the targets are cross-app config (metric_targets,
 * SA-editable) rather than code.
 *
 * Comparison is >=-INCLUSIVE and locked with THQ so labels never disagree:
 * exactly 95 against a target of 95 is On Target; 4.7499… against 4.75 is
 * Below Target. Scales are native — ratings 1–5, everything else 0–100 —
 * and the value is compared raw, no normalization.
 *
 * Null/NaN value → null (not-computed stays unclassified).
 * Missing target row → null (fail-visible, never a silent default).
 */
export function classifyVsTarget(
  metric: TargetMetricKey,
  value: number | null | undefined,
  targets: MetricTargets
): TargetLabel | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const target = targets[metric];
  if (target === undefined || Number.isNaN(target)) return null;
  return value >= target ? "On Target" : "Below Target";
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
