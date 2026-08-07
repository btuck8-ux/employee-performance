/**
 * Unit tests for the Phase 10 Total Impact Score math
 * (total-impact-score.ts). Pure functions; run standalone under Node's
 * type-stripping test runner.
 *
 * TS↔SQL parity: the SQL twin is `compute_total_impact_score_breakdown` in
 * supabase/migrations/025_total_impact_score.sql. The fixtures below encode
 * the shared contract — the 0.40 + 0.15×4 anchor weights, defensive [0,100]
 * clamps, pro-rata re-weighting, and the fewer-than-4-of-5 null rule — so a
 * change on either side that breaks lockstep shows up here. The eligibility
 * threshold is pinned against `compute_tis_rankings_for_quarter` (025) and
 * its mirror in 026 (`>= 40` all-time worked hours AND active).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeTotalImpactScoreBreakdown,
  classifyTotalImpactScore,
  toneForTotalImpactScore,
  isEligibleForRanking,
  DEFAULT_TIS_WEIGHTS,
  TIS_MIN_COMPONENTS,
  TIS_ELIGIBILITY_MIN_HOURS,
  TIS_GREEN_MIN,
  TIS_YELLOW_MIN,
} from "./total-impact-score.ts";

function assertClose(actual: number | null, expected: number, label = "value") {
  assert.ok(actual !== null, `${label} is null, expected ~${expected}`);
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label}: ${actual} !~ ${expected}`
  );
}

// ---------------------------------------------------------------------------
// Constants — pinned against the SQL literals in migrations 025 / 026.
// ---------------------------------------------------------------------------

test("anchor constants match migration 025/026 literals", () => {
  // 025's function gates on `cnt >= 4`.
  assert.equal(TIS_MIN_COMPONENTS, 4);
  // 025 `compute_tis_rankings_for_quarter` and 026 `compute_location_cs_score`
  // both hardcode `>= 40` all-time worked hours for eligibility.
  assert.equal(TIS_ELIGIBILITY_MIN_HOURS, 40);
  // Default weights match the config singleton seeded for 024/025.
  assert.equal(DEFAULT_TIS_WEIGHTS.weight_cs_score, 0.4);
  assert.equal(DEFAULT_TIS_WEIGHTS.weight_attendance, 0.15);
  assert.equal(DEFAULT_TIS_WEIGHTS.weight_on_time, 0.15);
  assert.equal(DEFAULT_TIS_WEIGHTS.weight_tasks, 0.15);
  assert.equal(DEFAULT_TIS_WEIGHTS.weight_survey, 0.15);
  // Same 85/70 bands as Phase 9.
  assert.equal(TIS_GREEN_MIN, 85);
  assert.equal(TIS_YELLOW_MIN, 70);
});

// ---------------------------------------------------------------------------
// computeTotalImpactScoreBreakdown — composite + re-weighting + null rule
// ---------------------------------------------------------------------------

test("all 5 components present: anchor weights apply untouched", () => {
  // composite = 0.4×90 + 0.15×100 + 0.15×80 + 0.15×70 + 0.15×60
  //           = 36 + 15 + 12 + 10.5 + 9 = 82.5
  const b = computeTotalImpactScoreBreakdown(90, 100, 80, 70, 60, DEFAULT_TIS_WEIGHTS);
  assert.equal(b.components_count, 5);
  assertClose(b.composite_score, 82.5, "composite");
  assert.equal(b.cs_component_score, 90);
  assert.equal(b.attendance_component_score, 100);
  assert.equal(b.on_time_component_score, 80);
  assert.equal(b.tasks_component_score, 70);
  assert.equal(b.survey_component_score, 60);
  assertClose(b.effective_weight_cs, 0.4, "ew cs");
  assertClose(b.effective_weight_attendance, 0.15, "ew attendance");
  assertClose(b.effective_weight_on_time, 0.15, "ew on-time");
  assertClose(b.effective_weight_tasks, 0.15, "ew tasks");
  assertClose(b.effective_weight_survey, 0.15, "ew survey");
});

test("4 present, CS Score missing: 0.15×4 re-weights to 0.25 each", () => {
  // composite = (100 + 80 + 70 + 60) / 4 = 77.5
  const b = computeTotalImpactScoreBreakdown(null, 100, 80, 70, 60, DEFAULT_TIS_WEIGHTS);
  assert.equal(b.components_count, 4);
  assert.equal(b.cs_component_score, null);
  assertClose(b.composite_score, 77.5, "composite");
  // Missing component's effective weight is 0 (not null) when composite exists.
  assert.equal(b.effective_weight_cs, 0);
  assertClose(b.effective_weight_attendance, 0.25, "ew attendance");
  assertClose(b.effective_weight_on_time, 0.25, "ew on-time");
  assertClose(b.effective_weight_tasks, 0.25, "ew tasks");
  assertClose(b.effective_weight_survey, 0.25, "ew survey");
});

test("4 present, attendance missing: re-weights over 0.85", () => {
  // composite = (0.4×90 + 0.15×80 + 0.15×70 + 0.15×60) / 0.85 = 67.5 / 0.85
  const b = computeTotalImpactScoreBreakdown(90, null, 80, 70, 60, DEFAULT_TIS_WEIGHTS);
  assert.equal(b.components_count, 4);
  assertClose(b.composite_score, 67.5 / 0.85, "composite");
  assertClose(b.effective_weight_cs, 0.4 / 0.85, "ew cs");
  assert.equal(b.effective_weight_attendance, 0);
});

test("4 present, on-time missing: re-weights over 0.85", () => {
  // composite = (0.4×90 + 0.15×100 + 0.15×70 + 0.15×60) / 0.85 = 70.5 / 0.85
  const b = computeTotalImpactScoreBreakdown(90, 100, null, 70, 60, DEFAULT_TIS_WEIGHTS);
  assert.equal(b.components_count, 4);
  assertClose(b.composite_score, 70.5 / 0.85, "composite");
  assert.equal(b.effective_weight_on_time, 0);
});

test("4 present, tasks missing: re-weights over 0.85", () => {
  // composite = (0.4×90 + 0.15×100 + 0.15×80 + 0.15×60) / 0.85 = 72 / 0.85
  const b = computeTotalImpactScoreBreakdown(90, 100, 80, null, 60, DEFAULT_TIS_WEIGHTS);
  assert.equal(b.components_count, 4);
  assertClose(b.composite_score, 72 / 0.85, "composite");
  assert.equal(b.effective_weight_tasks, 0);
});

test("4 present, survey missing: re-weights over 0.85", () => {
  // composite = (0.4×90 + 0.15×100 + 0.15×80 + 0.15×70) / 0.85 = 73.5 / 0.85
  const b = computeTotalImpactScoreBreakdown(90, 100, 80, 70, null, DEFAULT_TIS_WEIGHTS);
  assert.equal(b.components_count, 4);
  assertClose(b.composite_score, 73.5 / 0.85, "composite");
  assert.equal(b.effective_weight_survey, 0);
});

test("3 of 5 present: composite null, components still surfaced", () => {
  const b = computeTotalImpactScoreBreakdown(90, 100, 80, null, null, DEFAULT_TIS_WEIGHTS);
  assert.equal(b.components_count, 3);
  assert.equal(b.composite_score, null);
  assert.equal(b.cs_component_score, 90);
  assert.equal(b.attendance_component_score, 100);
  assert.equal(b.on_time_component_score, 80);
  assert.equal(b.tasks_component_score, null);
  assert.equal(b.survey_component_score, null);
  assert.equal(b.effective_weight_cs, null);
  assert.equal(b.effective_weight_attendance, null);
  assert.equal(b.effective_weight_on_time, null);
  assert.equal(b.effective_weight_tasks, null);
  assert.equal(b.effective_weight_survey, null);
});

test("no components: composite null, count 0", () => {
  const b = computeTotalImpactScoreBreakdown(null, null, null, null, null, DEFAULT_TIS_WEIGHTS);
  assert.equal(b.components_count, 0);
  assert.equal(b.composite_score, null);
});

test("defensive clamp: out-of-band inputs are clamped to [0, 100]", () => {
  // Mirrors 025's `greatest(0, least(100, x))` per component.
  // att 105 → 100, on-time -5 → 0
  // composite = 0.4×90 + 0.15×100 + 0.15×0 + 0.15×70 + 0.15×60 = 70.5
  const b = computeTotalImpactScoreBreakdown(90, 105, -5, 70, 60, DEFAULT_TIS_WEIGHTS);
  assert.equal(b.components_count, 5);
  assert.equal(b.attendance_component_score, 100);
  assert.equal(b.on_time_component_score, 0);
  assertClose(b.composite_score, 70.5, "composite");
});

test("non-finite inputs are treated as missing, not clamped", () => {
  const b = computeTotalImpactScoreBreakdown(
    Number.NaN, 100, 80, 70, 60, DEFAULT_TIS_WEIGHTS
  );
  assert.equal(b.components_count, 4);
  assert.equal(b.cs_component_score, null);
  assertClose(b.composite_score, 77.5, "composite");
});

test("degenerate zero-weight config with 4 components present: TS returns null", () => {
  // TS↔SQL PARITY: divergence (same shape as the Phase 9 one). With cnt ≥ 4
  // but every PRESENT weight = 0 (wSum ≤ 0), TS returns a null composite
  // (`cnt < TIS_MIN_COMPONENTS || wSum <= 0` guard). The SQL twin in 025
  // gates effective weights on `w_sum > 0` but the final composite only on
  // `cnt >= 4`, so `coalesce(NULL * score, 0) + ...` yields composite = 0
  // instead of NULL. Only reachable with a degenerate weight config.
  // Asserting CURRENT TS behavior; resolution is a Tucker-decision.
  const b = computeTotalImpactScoreBreakdown(90, 100, 80, 70, null, {
    weight_cs_score: 0,
    weight_attendance: 0,
    weight_on_time: 0,
    weight_tasks: 0,
    weight_survey: 0.15, // only the MISSING component carries weight
  });
  assert.equal(b.components_count, 4);
  assert.equal(b.composite_score, null);
  assert.equal(b.effective_weight_cs, null);
});

// ---------------------------------------------------------------------------
// classify / tone — 85/70 bands (same as Phase 9)
// ---------------------------------------------------------------------------

test("classifyTotalImpactScore boundaries: ≥85 / ≥70 / below", () => {
  assert.equal(classifyTotalImpactScore(100), "Exceeds Expectations");
  assert.equal(classifyTotalImpactScore(85), "Exceeds Expectations"); // inclusive
  assert.equal(classifyTotalImpactScore(84.999), "Meets Expectations");
  assert.equal(classifyTotalImpactScore(70), "Meets Expectations"); // inclusive
  assert.equal(classifyTotalImpactScore(69.999), "Below Expectations");
  assert.equal(classifyTotalImpactScore(null), null);
  assert.equal(classifyTotalImpactScore(Number.NaN), null);
});

test("toneForTotalImpactScore boundaries mirror classify + muted null", () => {
  assert.equal(toneForTotalImpactScore(85), "green");
  assert.equal(toneForTotalImpactScore(84.999), "yellow");
  assert.equal(toneForTotalImpactScore(70), "yellow");
  assert.equal(toneForTotalImpactScore(69.999), "red");
  assert.equal(toneForTotalImpactScore(null), "muted");
});

// ---------------------------------------------------------------------------
// isEligibleForRanking — active AND all-time hours ≥ 40 (025 / 026)
// ---------------------------------------------------------------------------

test("isEligibleForRanking: 40-hour boundary is inclusive, active required", () => {
  assert.equal(isEligibleForRanking(true, TIS_ELIGIBILITY_MIN_HOURS), true); // exactly 40
  assert.equal(isEligibleForRanking(true, 39.99), false);
  assert.equal(isEligibleForRanking(true, 0), false);
  assert.equal(isEligibleForRanking(false, 1000), false); // inactive never eligible
  assert.equal(isEligibleForRanking(true, 40.01), true);
});
