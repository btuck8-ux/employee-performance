/**
 * Phase 9 — Customer Service Score math.
 *
 * Mirrors the SQL function in migration 023 (`compute_customer_service_score_breakdown`).
 * Source of truth for runtime / display; keep the two in lockstep when the
 * normalization or null-handling rules change.
 *
 * Spec: phase-9-customer-service-score-spec.md (locked 2026-05-16).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExpectationLabel } from "./types";

/** Half-window for the tip-rate-delta normalization (percentage points). */
export const TIP_DELTA_WINDOW_PP = 2;

/** Threshold cutoffs shared across composite + per-component badges. */
export const CS_SCORE_GREEN_MIN = 85;
export const CS_SCORE_YELLOW_MIN = 70;

export interface CustomerServiceWeights {
  weight_tattle: number;
  weight_reviews: number;
  weight_tip: number;
}

export const DEFAULT_CS_WEIGHTS: CustomerServiceWeights = {
  weight_tattle: 0.4,
  weight_reviews: 0.4,
  weight_tip: 0.2,
};

export interface CustomerServiceScoreBreakdown {
  /** 0–100 composite; null when fewer than 2 components are present. */
  composite_score: number | null;
  /** 0..3 — how many of the three components contributed. */
  components_count: 0 | 1 | 2 | 3;
  /** Per-component normalized 0–100 scores; null when the component is missing. */
  tattle_component_score: number | null;
  reviews_component_score: number | null;
  tip_component_score: number | null;
  /** Effective (post re-weight) weights; 0 when component missing; null when composite is null. */
  effective_weight_tattle: number | null;
  effective_weight_reviews: number | null;
  effective_weight_tip: number | null;
}

function clamp01_100(x: number): number {
  if (x < 0) return 0;
  if (x > 100) return 100;
  return x;
}

/** (rating − 1) / 4 × 100 → 0..100 (pure linear). Null in → null out. */
export function normalizeRatingTo100(rating: number | null): number | null {
  if (rating === null || !Number.isFinite(rating)) return null;
  return clamp01_100(((rating - 1) / 4) * 100);
}

/** (delta + 2) / 4 × 100 → 0..100, clamped. Null in → null out. */
export function normalizeTipDeltaTo100(deltaPp: number | null): number | null {
  if (deltaPp === null || !Number.isFinite(deltaPp)) return null;
  return clamp01_100(((deltaPp + TIP_DELTA_WINDOW_PP) / (TIP_DELTA_WINDOW_PP * 2)) * 100);
}

/**
 * Compute the composite + breakdown from native inputs and configured weights.
 * Pure function — mirrors the SQL `compute_customer_service_score_breakdown`.
 */
export function computeCustomerServiceScoreBreakdown(
  tattleRating: number | null,
  reviewsRating: number | null,
  tipRateDeltaPp: number | null,
  weights: CustomerServiceWeights
): CustomerServiceScoreBreakdown {
  const t = normalizeRatingTo100(tattleRating);
  const r = normalizeRatingTo100(reviewsRating);
  const p = normalizeTipDeltaTo100(tipRateDeltaPp);

  const wT = t !== null ? weights.weight_tattle : 0;
  const wR = r !== null ? weights.weight_reviews : 0;
  const wP = p !== null ? weights.weight_tip : 0;
  const wSum = wT + wR + wP;

  const cnt = ((t !== null ? 1 : 0) + (r !== null ? 1 : 0) + (p !== null ? 1 : 0)) as 0 | 1 | 2 | 3;

  if (cnt < 2) {
    return {
      composite_score: null,
      components_count: cnt,
      tattle_component_score: t,
      reviews_component_score: r,
      tip_component_score: p,
      effective_weight_tattle: null,
      effective_weight_reviews: null,
      effective_weight_tip: null,
    };
  }

  if (wSum <= 0) {
    // Degenerate all-zero-weights config: composite 0 with null effective
    // weights, matching the deployed SQL (023, canonical — Tucker 2026-08-07).
    return {
      composite_score: 0,
      components_count: cnt,
      tattle_component_score: t,
      reviews_component_score: r,
      tip_component_score: p,
      effective_weight_tattle: null,
      effective_weight_reviews: null,
      effective_weight_tip: null,
    };
  }

  const ewT = wT / wSum;
  const ewR = wR / wSum;
  const ewP = wP / wSum;

  const composite =
    (t !== null ? ewT * t : 0) +
    (r !== null ? ewR * r : 0) +
    (p !== null ? ewP * p : 0);

  return {
    composite_score: composite,
    components_count: cnt,
    tattle_component_score: t,
    reviews_component_score: r,
    tip_component_score: p,
    effective_weight_tattle: ewT,
    effective_weight_reviews: ewR,
    effective_weight_tip: ewP,
  };
}

/**
 * Map a 0–100 score (composite OR per-component) to the threshold band per spec.
 * ≥85 green, 70–<85 yellow, <70 red. Returns null when input is null.
 *
 * Uses the existing ExpectationLabel enum so callers can reuse <ExpectationBadge />.
 */
export function classifyCustomerServiceScore(
  value: number | null
): ExpectationLabel | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value >= CS_SCORE_GREEN_MIN) return "Exceeds Expectations";
  if (value >= CS_SCORE_YELLOW_MIN) return "Meets Expectations";
  return "Below Expectations";
}

/** Short tone label used by smaller UI surfaces. */
export type CsScoreTone = "green" | "yellow" | "red" | "muted";

export function toneForCustomerServiceScore(value: number | null): CsScoreTone {
  if (value === null || !Number.isFinite(value)) return "muted";
  if (value >= CS_SCORE_GREEN_MIN) return "green";
  if (value >= CS_SCORE_YELLOW_MIN) return "yellow";
  return "red";
}

/** Display-rounded composite (whole numbers per spec). */
export function formatCustomerServiceScore(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return Math.round(value).toString();
}

/**
 * Fetch the singleton weight config. Falls back to defaults if the row is
 * missing or unreadable — keeps the recompute path resilient. Defaults match
 * the migration's default row (0.40/0.40/0.20).
 */
export async function fetchCustomerServiceWeights(
  supabase: SupabaseClient
): Promise<CustomerServiceWeights> {
  const { data, error } = await supabase
    .from("customer_service_score_config")
    .select("weight_tattle, weight_reviews, weight_tip")
    .limit(1)
    .maybeSingle();
  if (error || !data) return { ...DEFAULT_CS_WEIGHTS };
  const toNum = (v: number | string | null | undefined, fallback: number) => {
    if (v === null || v === undefined) return fallback;
    const n = typeof v === "string" ? Number(v) : v;
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    weight_tattle: toNum(data.weight_tattle, DEFAULT_CS_WEIGHTS.weight_tattle),
    weight_reviews: toNum(data.weight_reviews, DEFAULT_CS_WEIGHTS.weight_reviews),
    weight_tip: toNum(data.weight_tip, DEFAULT_CS_WEIGHTS.weight_tip),
  };
}
