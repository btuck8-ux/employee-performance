/**
 * Multi-location combined-metrics tests (§4-B9, 2026-08-23 sprint).
 * Fixture shape is Keara Beck's real pair — 7shifts id 10437864 at HRANCH
 * (EMP-100132) + LONGM (EMP-100152). The 50%/100% → 90.9% case is THE pin:
 * averaging the rates gives 75%, which is the error class this workstream
 * exists to prevent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  combineQuarterMetrics,
  meanPartsFromValues,
  type LocationQuarterMetrics,
} from "./multi-location-metrics.ts";

const EMPTY_MEAN = { sum: 0, n: 0 };

function locationQuarter(
  overrides: Partial<LocationQuarterMetrics>
): LocationQuarterMetrics {
  return {
    employeeId: "emp",
    // W6 composite identity: required by the type, ignored by the combine
    // math — the 10 combine assertions below are unchanged.
    locationId: "loc",
    belowFloor: false,
    quarterId: "q",
    attendance: { num: 0, den: 0 },
    onTime: { num: 0, den: 0 },
    onTimeGrace: { num: 0, den: 0 },
    surveyEngagement: { num: 0, den: 0 },
    csRating: EMPTY_MEAN,
    tattleRating: EMPTY_MEAN,
    tattleFood: EMPTY_MEAN,
    tattleAccuracy: EMPTY_MEAN,
    tattleSpeed: EMPTY_MEAN,
    tattleQuantity: 0,
    reviewQuantity: 0,
    avgTaskListCompletionPct: null,
    ...overrides,
  };
}

test("50% (2/4) + 100% (18/18) combines to 90.9%, never 75%", () => {
  // Keara Beck shape: HRANCH 2 of 4, LONGM 18 of 18.
  const hranch = locationQuarter({
    employeeId: "keara-hranch",
    attendance: { num: 2, den: 4 },
  });
  const longm = locationQuarter({
    employeeId: "keara-longm",
    attendance: { num: 18, den: 18 },
  });
  const c = combineQuarterMetrics([hranch, longm]);
  assert.equal(c.attended_count, 20);
  assert.equal(c.scheduled_count, 22);
  assert.equal(Number(c.attendance_pct!.toFixed(1)), 90.9);
  assert.notEqual(Number(c.attendance_pct!.toFixed(1)), 75.0);
});

test("one site with data + one with a zero denominator yields the one site's number", () => {
  // §4-B7: NOT null, NOT halved.
  const withData = locationQuarter({ attendance: { num: 18, den: 18 } });
  const noData = locationQuarter({ attendance: { num: 0, den: 0 } });
  const c = combineQuarterMetrics([withData, noData]);
  assert.equal(c.attendance_pct, 100);
});

test("all contributing denominators zero yields null, never 0", () => {
  const a = locationQuarter({});
  const b = locationQuarter({});
  const c = combineQuarterMetrics([a, b]);
  assert.equal(c.attendance_pct, null);
  assert.equal(c.on_time_pct, null);
  assert.equal(c.on_time_grace_pct, null);
  assert.equal(c.survey_engagement_pct, null);
  assert.equal(c.customer_service_rating, null);
  assert.equal(c.tattle_rating, null);
  assert.equal(c.tattle_score_food_quality, null);
});

test("means combine by (sum, n) parts — the true non-null denominators (§4-B6)", () => {
  // Site A: 3 tattle surveys, food score present on only 1 (value 5).
  // Site B: 1 survey, food 3. Combined food = (5+3)/2 = 4.0 — weighting the
  // per-site averages by tattle_quantity would give (5*3 + 3*1)/4 = 4.5.
  const a = locationQuarter({
    tattleFood: meanPartsFromValues([5, null, null]),
    tattleQuantity: 3,
  });
  const b = locationQuarter({
    tattleFood: meanPartsFromValues([3]),
    tattleQuantity: 1,
  });
  const c = combineQuarterMetrics([a, b]);
  assert.equal(c.tattle_score_food_quality, 4);
  assert.equal(c.tattle_quantity, 4);
});

test("counts sum normally", () => {
  const a = locationQuarter({
    surveyEngagement: { num: 3, den: 4 },
    reviewQuantity: 2,
  });
  const b = locationQuarter({
    surveyEngagement: { num: 1, den: 1 },
    reviewQuantity: 5,
  });
  const c = combineQuarterMetrics([a, b]);
  assert.equal(c.surveys_completed, 4);
  assert.equal(c.surveys_assigned, 5);
  assert.equal(Number(c.survey_engagement_pct!.toFixed(1)), 80.0);
  assert.equal(c.customer_review_quantity, 7);
});

test("meanPartsFromValues skips nulls and NaN", () => {
  assert.deepEqual(meanPartsFromValues([4, null, 2, NaN]), { sum: 6, n: 2 });
  assert.deepEqual(meanPartsFromValues([]), { sum: 0, n: 0 });
});

// ── Text-level pins (repo convention) ───────────────────────────────────────

test("no averaging of _pct values anywhere in the new multi-location modules", () => {
  for (const file of [
    "src/lib/multi-location-metrics.ts",
    "src/lib/multi-location-fetch.ts",
    "src/components/employee/MultiLocationCard.tsx",
  ]) {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    assert.doesNotMatch(
      src,
      /_pct\s*[+]\s*\w*_pct/,
      `${file}: two _pct values must never be added (averaging smell)`
    );
    assert.doesNotMatch(
      src,
      /\attendance_pct\s*\)\s*\/\s*2/,
      `${file}: _pct values must never be divided by a count`
    );
    assert.doesNotMatch(
      src,
      /pct.*\*\s*0\.5/,
      `${file}: no half-weighting of pct values`
    );
  }
});

test("identity joins on seven_shifts_user_id, never on name (§4-B2)", () => {
  const src = readFileSync(
    join(process.cwd(), "src/lib/multi-location-fetch.ts"),
    "utf8"
  );
  assert.match(src, /\.eq\("seven_shifts_user_id", sevenShiftsUserId\)/);
  assert.doesNotMatch(src, /\.eq\("employee_name"/);
  assert.doesNotMatch(src, /\.ilike\(/);
  // Null ids never group (the two null-id NOLA rows are single-location by
  // definition).
  assert.match(src, /sevenShiftsUserId === null[\s\S]*return null/);
});

test("per-location-then-sum: entries are fetched per sibling id, never pooled into one compute call", () => {
  const src = readFileSync(
    join(process.cwd(), "src/lib/multi-location-fetch.ts"),
    "utf8"
  );
  // computeMetricsFromEntries keys its maps on the date alone — pooling two
  // locations' entries into one call silently collapses same-day shifts
  // (§4-B4). The call must sit inside the per-sibling loop.
  assert.match(src, /for \(const s of siblings\) \{[\s\S]*computeMetricsFromEntries\(/);
  assert.doesNotMatch(
    src,
    /computeMetricsFromEntries\(\s*\[?\s*\.\.\./,
    "no spread-merged entry arrays into a single compute call"
  );
});

test("overview-metrics.ts is untouched by this workstream (§4-B8)", () => {
  // The store-rollup display rule (unweighted mean over employees) is a
  // different, locked question. This pin fails if someone imports the
  // multi-location combiner there.
  const src = readFileSync(
    join(process.cwd(), "src/lib/overview-metrics.ts"),
    "utf8"
  );
  assert.doesNotMatch(src, /multi-location/);
});
