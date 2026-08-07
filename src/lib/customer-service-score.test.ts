/**
 * Unit tests for the Phase 9 Customer Service Score math
 * (customer-service-score.ts). Pure functions; run standalone under Node's
 * type-stripping test runner.
 *
 * TS↔SQL parity: the SQL twin is `compute_customer_service_score_breakdown`
 * in supabase/migrations/023_customer_service_score.sql. The fixtures below
 * encode the shared contract — normalization formulas, the 0.40/0.40/0.20
 * anchor weights, pro-rata re-weighting, and the fewer-than-2-components
 * null rule — so a change on either side that breaks lockstep shows up here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRatingTo100,
  normalizeTipDeltaTo100,
  computeCustomerServiceScoreBreakdown,
  classifyCustomerServiceScore,
  toneForCustomerServiceScore,
  DEFAULT_CS_WEIGHTS,
  TIP_DELTA_WINDOW_PP,
  CS_SCORE_GREEN_MIN,
  CS_SCORE_YELLOW_MIN,
} from "./customer-service-score.ts";

function assertClose(actual: number | null, expected: number, label = "value") {
  assert.ok(actual !== null, `${label} is null, expected ~${expected}`);
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label}: ${actual} !~ ${expected}`
  );
}

// ---------------------------------------------------------------------------
// Constants — pinned against the SQL literals in migration 023.
// ---------------------------------------------------------------------------

test("anchor constants match migration 023 literals", () => {
  // 023 hardcodes `(p_tip_rate_delta_pp + 2) / 4.0` — the TS constant must
  // stay 2 (half-window) or the two sides drift.
  assert.equal(TIP_DELTA_WINDOW_PP, 2);
  // Default weights match the config singleton seeded for 023 (0.40/0.40/0.20).
  assert.equal(DEFAULT_CS_WEIGHTS.weight_tattle, 0.4);
  assert.equal(DEFAULT_CS_WEIGHTS.weight_reviews, 0.4);
  assert.equal(DEFAULT_CS_WEIGHTS.weight_tip, 0.2);
  // Threshold bands per spec: ≥85 green, 70–<85 yellow.
  assert.equal(CS_SCORE_GREEN_MIN, 85);
  assert.equal(CS_SCORE_YELLOW_MIN, 70);
});

// ---------------------------------------------------------------------------
// normalizeRatingTo100 — (rating − 1) / 4 × 100, clamped 0..100 (023 `raw` CTE)
// ---------------------------------------------------------------------------

test("normalizeRatingTo100 maps the 1..5 scale linearly onto 0..100", () => {
  assert.equal(normalizeRatingTo100(1), 0);
  assert.equal(normalizeRatingTo100(3), 50);
  assert.equal(normalizeRatingTo100(4.5), 87.5);
  assert.equal(normalizeRatingTo100(5), 100);
  assertClose(normalizeRatingTo100(4.2), 80, "rating 4.2");
});

test("normalizeRatingTo100 clamps out-of-scale ratings and nulls bad input", () => {
  assert.equal(normalizeRatingTo100(0.5), 0); // below scale → clamped to 0
  assert.equal(normalizeRatingTo100(6), 100); // above scale → clamped to 100
  assert.equal(normalizeRatingTo100(null), null);
  assert.equal(normalizeRatingTo100(Number.NaN), null);
  assert.equal(normalizeRatingTo100(Number.POSITIVE_INFINITY), null);
});

// ---------------------------------------------------------------------------
// normalizeTipDeltaTo100 — (delta + 2) / 4 × 100, clamped (window ±2pp)
// ---------------------------------------------------------------------------

test("normalizeTipDeltaTo100 maps the ±2pp window onto 0..100", () => {
  assert.equal(normalizeTipDeltaTo100(-TIP_DELTA_WINDOW_PP), 0); // -2pp → 0
  assert.equal(normalizeTipDeltaTo100(-1), 25);
  assert.equal(normalizeTipDeltaTo100(0), 50); // at the location average
  assert.equal(normalizeTipDeltaTo100(1), 75);
  assert.equal(normalizeTipDeltaTo100(TIP_DELTA_WINDOW_PP), 100); // +2pp → 100
});

test("normalizeTipDeltaTo100 clamps beyond the window and nulls bad input", () => {
  assert.equal(normalizeTipDeltaTo100(-3.7), 0);
  assert.equal(normalizeTipDeltaTo100(9), 100);
  assert.equal(normalizeTipDeltaTo100(null), null);
  assert.equal(normalizeTipDeltaTo100(Number.NaN), null);
});

// ---------------------------------------------------------------------------
// computeCustomerServiceScoreBreakdown — composite + re-weighting + null rule
// ---------------------------------------------------------------------------

test("all 3 components present: anchor weights apply untouched", () => {
  // tattle 4.5 → 87.5, reviews 5 → 100, tip +1pp → 75
  // composite = 0.4×87.5 + 0.4×100 + 0.2×75 = 35 + 40 + 15 = 90
  const b = computeCustomerServiceScoreBreakdown(4.5, 5, 1, DEFAULT_CS_WEIGHTS);
  assert.equal(b.components_count, 3);
  assert.equal(b.tattle_component_score, 87.5);
  assert.equal(b.reviews_component_score, 100);
  assert.equal(b.tip_component_score, 75);
  assertClose(b.composite_score, 90, "composite");
  assertClose(b.effective_weight_tattle, 0.4, "ew tattle");
  assertClose(b.effective_weight_reviews, 0.4, "ew reviews");
  assertClose(b.effective_weight_tip, 0.2, "ew tip");
});

test("tattle + reviews (tip missing): 0.4/0.4 re-weights to 0.5/0.5", () => {
  // tattle 4.5 → 87.5, reviews 3 → 50; composite = 0.5×87.5 + 0.5×50 = 68.75
  const b = computeCustomerServiceScoreBreakdown(4.5, 3, null, DEFAULT_CS_WEIGHTS);
  assert.equal(b.components_count, 2);
  assert.equal(b.tip_component_score, null);
  assertClose(b.composite_score, 68.75, "composite");
  assertClose(b.effective_weight_tattle, 0.5, "ew tattle");
  assertClose(b.effective_weight_reviews, 0.5, "ew reviews");
  // Missing component's effective weight is 0 (not null) when composite exists.
  assert.equal(b.effective_weight_tip, 0);
});

test("tattle + tip (reviews missing): re-weights to 2/3 and 1/3", () => {
  // tattle 5 → 100, tip 0pp → 50
  // composite = (0.4×100 + 0.2×50) / 0.6 = 50 / 0.6 ≈ 83.3333
  const b = computeCustomerServiceScoreBreakdown(5, null, 0, DEFAULT_CS_WEIGHTS);
  assert.equal(b.components_count, 2);
  assert.equal(b.reviews_component_score, null);
  assertClose(b.composite_score, 50 / 0.6, "composite");
  assertClose(b.effective_weight_tattle, 0.4 / 0.6, "ew tattle");
  assertClose(b.effective_weight_tip, 0.2 / 0.6, "ew tip");
  assert.equal(b.effective_weight_reviews, 0);
});

test("reviews + tip (tattle missing): re-weights to 2/3 and 1/3", () => {
  // reviews 5 → 100, tip -2pp → 0
  // composite = (0.4×100 + 0.2×0) / 0.6 = 40 / 0.6 ≈ 66.6667
  const b = computeCustomerServiceScoreBreakdown(null, 5, -2, DEFAULT_CS_WEIGHTS);
  assert.equal(b.components_count, 2);
  assert.equal(b.tattle_component_score, null);
  assert.equal(b.tip_component_score, 0);
  assertClose(b.composite_score, 40 / 0.6, "composite");
  assertClose(b.effective_weight_reviews, 0.4 / 0.6, "ew reviews");
  assertClose(b.effective_weight_tip, 0.2 / 0.6, "ew tip");
  assert.equal(b.effective_weight_tattle, 0);
});

test("single component: composite null, component score still surfaced", () => {
  // Per spec (023 header): 1 of 3 present is NOT a composite — callers render
  // the raw single-source view instead.
  for (const [t, r, p] of [
    [4.5, null, null],
    [null, 4.5, null],
    [null, null, 1],
  ] as const) {
    const b = computeCustomerServiceScoreBreakdown(t, r, p, DEFAULT_CS_WEIGHTS);
    assert.equal(b.composite_score, null);
    assert.equal(b.components_count, 1);
    assert.equal(b.effective_weight_tattle, null);
    assert.equal(b.effective_weight_reviews, null);
    assert.equal(b.effective_weight_tip, null);
  }
  const only = computeCustomerServiceScoreBreakdown(4.5, null, null, DEFAULT_CS_WEIGHTS);
  assert.equal(only.tattle_component_score, 87.5);
  assert.equal(only.reviews_component_score, null);
  assert.equal(only.tip_component_score, null);
});

test("no components: composite null, count 0", () => {
  const b = computeCustomerServiceScoreBreakdown(null, null, null, DEFAULT_CS_WEIGHTS);
  assert.equal(b.composite_score, null);
  assert.equal(b.components_count, 0);
  assert.equal(b.tattle_component_score, null);
  assert.equal(b.reviews_component_score, null);
  assert.equal(b.tip_component_score, null);
});

test("degenerate zero-weight config with 2 components present: TS returns null", () => {
  // TS↔SQL PARITY: divergence. With cnt ≥ 2 but every PRESENT weight = 0
  // (wSum ≤ 0), TS returns a null composite (the `cnt < 2 || wSum <= 0`
  // guard). The SQL twin in 023 gates the effective weights on `w_sum > 0`
  // but gates the final composite only on `cnt >= 2`, so
  // `coalesce(NULL * score, 0) + ...` sums to composite = 0 instead of NULL.
  // Only reachable with a degenerate weight config (defaults are non-zero).
  // Asserting CURRENT TS behavior; resolution is a Tucker-decision.
  const b = computeCustomerServiceScoreBreakdown(5, 5, null, {
    weight_tattle: 0,
    weight_reviews: 0,
    weight_tip: 0.2,
  });
  assert.equal(b.components_count, 2);
  assert.equal(b.composite_score, null);
  assert.equal(b.effective_weight_tattle, null);
});

// ---------------------------------------------------------------------------
// classifyCustomerServiceScore / toneForCustomerServiceScore — 85/70 bands
// ---------------------------------------------------------------------------

test("classifyCustomerServiceScore boundaries: ≥85 / ≥70 / below", () => {
  assert.equal(classifyCustomerServiceScore(100), "Exceeds Expectations");
  assert.equal(classifyCustomerServiceScore(85), "Exceeds Expectations"); // inclusive
  assert.equal(classifyCustomerServiceScore(84.999), "Meets Expectations");
  assert.equal(classifyCustomerServiceScore(70), "Meets Expectations"); // inclusive
  assert.equal(classifyCustomerServiceScore(69.999), "Below Expectations");
  assert.equal(classifyCustomerServiceScore(0), "Below Expectations");
  assert.equal(classifyCustomerServiceScore(null), null);
  assert.equal(classifyCustomerServiceScore(Number.NaN), null);
});

test("toneForCustomerServiceScore boundaries mirror classify + muted null", () => {
  assert.equal(toneForCustomerServiceScore(85), "green");
  assert.equal(toneForCustomerServiceScore(84.999), "yellow");
  assert.equal(toneForCustomerServiceScore(70), "yellow");
  assert.equal(toneForCustomerServiceScore(69.999), "red");
  assert.equal(toneForCustomerServiceScore(null), "muted");
  assert.equal(toneForCustomerServiceScore(Number.NaN), "muted");
});
