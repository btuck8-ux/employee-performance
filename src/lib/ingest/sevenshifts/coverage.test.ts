/**
 * Unit tests for the worked-day coverage check's pure logic (Step 3 guard).
 *
 * Runs on Node's built-in test runner with native TypeScript type-stripping —
 * no test framework dependency:
 *
 *   node --test src/lib/ingest/sevenshifts/coverage.test.ts
 *   npm test            # runs every *.test.ts under the ingest path
 *
 * coverage.ts imports only types from sibling modules, so type-stripping leaves
 * it with zero runtime imports and the pure helpers are exercised in isolation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { QuarterInfo } from "@/lib/quarter";
import {
  coverageReasons,
  quarterCoverageWindow,
  isoDate,
  COVERAGE_THRESHOLD,
  type CoverageReport,
} from "./coverage.ts";

function report(over: Partial<CoverageReport>): CoverageReport {
  return {
    location_id: "id",
    location_code: "HOU",
    worked_days: 0,
    expected_days: 0,
    coverage_pct: 0,
    below_threshold: false,
    ...over,
  };
}

test("isoDate formats local Y-M-D (no UTC roll-back)", () => {
  // Local midnight Jan 1 must stay Jan 1 regardless of negative-offset TZ.
  assert.equal(isoDate(new Date(2026, 0, 1)), "2026-01-01");
  assert.equal(isoDate(new Date(2026, 4, 9)), "2026-05-09");
});

test("quarterCoverageWindow caps end at today when mid-quarter", () => {
  const q: QuarterInfo = {
    year: 2026,
    quarter: 2,
    label: "Q2 2026",
    periodStart: new Date(2026, 3, 1), // Apr 1
    periodEnd: new Date(2026, 5, 30), // Jun 30
  };
  const win = quarterCoverageWindow(q, new Date(2026, 5, 9)); // Jun 9
  assert.equal(win.startIso, "2026-04-01");
  assert.equal(win.endIso, "2026-06-09");
  assert.equal(win.expectedDays, 70); // Apr(30)+May(31)+Jun 1..9(9)
  assert.equal(win.label, "Q2 2026");
});

test("quarterCoverageWindow caps end at quarter end after the quarter", () => {
  const q: QuarterInfo = {
    year: 2026,
    quarter: 2,
    label: "Q2 2026",
    periodStart: new Date(2026, 3, 1),
    periodEnd: new Date(2026, 5, 30),
  };
  const win = quarterCoverageWindow(q, new Date(2026, 8, 1)); // Sep 1, past Q2
  assert.equal(win.endIso, "2026-06-30");
  assert.equal(win.expectedDays, 91); // full Q2
});

test("coverageReasons emits only below-threshold locations", () => {
  const reasons = coverageReasons(
    [
      report({ location_code: "HOU", worked_days: 2, expected_days: 70, coverage_pct: 0.029, below_threshold: true }),
      report({ location_code: "COS", worked_days: 68, expected_days: 70, coverage_pct: 0.971, below_threshold: false }),
    ],
    "Q2 2026"
  );
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /^HOU worked coverage 2\/70 days \(3%\) below 80% for Q2 2026$/);
});

test("coverageReasons is empty when all locations are healthy", () => {
  const reasons = coverageReasons(
    [report({ below_threshold: false }), report({ location_code: "COS", below_threshold: false })],
    "Q2 2026"
  );
  assert.equal(reasons.length, 0);
});

test("COVERAGE_THRESHOLD is the documented 80%", () => {
  assert.equal(COVERAGE_THRESHOLD, 0.8);
});
