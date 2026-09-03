/**
 * Unit tests for decideAlert() — specifically the status-blind recompute-failure
 * clause added 2026-09-02.
 *
 * The hole it closes: every ingest writer sets the run's status from the INGEST
 * outcome (rows pulled/upserted), so a run can fail every downstream score
 * recompute and still log `success`. On 2026-09-01, 329 of 416 recompute
 * failures rode `status: 'success'` runs and the alert saw none of them.
 * decideAlert() must read detail.recompute_failures / recompute_failure_count
 * regardless of status — and NEVER error_text, which undercounts ~5×.
 *
 *   node --test src/lib/ingest/sevenshifts/alert.test.ts
 *
 * decideAlert() is a pure function over RunOutcome[]; no DB, no fetch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAlert } from "./alert.ts";
import type { RunOutcome } from "./runs.ts";

function run(overrides: Partial<RunOutcome>): RunOutcome {
  return {
    source: "7shifts_time",
    location_id: "loc-1",
    location_code: "CPD",
    status: "success",
    rows_in: 100,
    rows_upserted: 100,
    rows_skipped: 0,
    detail: null,
    error_text: null,
    window_start: "2026-09-01T00:00:00Z",
    window_end: "2026-09-02T00:00:00Z",
    ...overrides,
  };
}

test("a success-status run carrying recompute failures fires the alert (the 2026-09-01 hole)", () => {
  const decision = decideAlert([
    run({
      status: "success",
      detail: { recompute_failures: [{ reason: "upsert failed" }] },
    }),
  ]);
  assert.equal(decision.shouldAlert, true);
  assert.ok(
    decision.reasons.some((r) => r.includes("1 recompute failure(s) across 1 run(s)")),
    `reasons: ${decision.reasons.join("; ")}`
  );
});

test("failures are summed across runs and statuses", () => {
  const decision = decideAlert([
    run({ status: "success", detail: { recompute_failures: [{}, {}, {}] } }),
    run({
      status: "error",
      location_code: "HOU",
      error_text: "boom",
      detail: { recompute_failures: [{}, {}] },
    }),
    run({ status: "success", location_code: "COS", detail: {} }),
  ]);
  assert.equal(decision.shouldAlert, true);
  assert.ok(
    decision.reasons.some((r) => r.includes("5 recompute failure(s) across 2 run(s)")),
    `reasons: ${decision.reasons.join("; ")}`
  );
});

test("recompute_failure_count is preferred over the capped sample (truncation guard)", () => {
  // Every ingest writer stores rc.failures.slice(0, 20); the integer beside it
  // is the exact count. A run past the cap must report the integer, not 20.
  const decision = decideAlert([
    run({
      detail: {
        recompute_failure_count: 57,
        recompute_failures: new Array(20).fill({}),
      },
    }),
  ]);
  assert.ok(
    decision.reasons.some((r) => r.includes("57 recompute failure(s)")),
    `reasons: ${decision.reasons.join("; ")}`
  );
});

test("legacy rows without recompute_failure_count fall back to the sampled array", () => {
  const decision = decideAlert([
    run({ detail: { recompute_failures: [{}, {}] } }),
  ]);
  assert.ok(
    decision.reasons.some((r) => r.includes("2 recompute failure(s)")),
    `reasons: ${decision.reasons.join("; ")}`
  );
});

test("discrimination: error-status runs with ZERO recompute failures alert only for the error, not for recomputes", () => {
  // The known-good 2026-09-02 window holds five 7tasks runs at status 'error'
  // (the separate pkey escalation) carrying no recompute failures. The error
  // clause fires; the recompute clause must stay silent about them.
  const decision = decideAlert([
    run({ source: "7tasks", status: "error", error_text: "pkey collision", detail: {} }),
    run({ source: "7tasks", status: "error", error_text: "pkey collision", detail: null }),
  ]);
  assert.equal(decision.shouldAlert, true);
  assert.ok(decision.reasons.some((r) => r.includes("2 run(s) errored")));
  assert.ok(
    !decision.reasons.some((r) => r.includes("recompute failure")),
    `unexpected recompute reason: ${decision.reasons.join("; ")}`
  );
});

test("a clean cycle stays silent (no false positive)", () => {
  const decision = decideAlert([
    run({ detail: { recompute_failures: [], recompute_failure_count: 0 } }),
    run({ location_code: "HOU", detail: {} }),
    run({ source: "toast_sales", location_code: "HOU", detail: null }),
  ]);
  assert.equal(decision.shouldAlert, false);
  assert.deepEqual(decision.reasons, []);
});

test("counts come off detail, never error_text (the 5× undercount trap)", () => {
  // cp_schedule/culture_pulse/cake collapse failures to a summary STRING in
  // error_text. Only detail carries the countable array.
  const decision = decideAlert([
    run({
      source: "cp_schedule",
      status: "success",
      error_text: "4 recompute failure(s); see detail",
      detail: { recompute_failures: [{}, {}, {}, {}], recompute_failure_count: 4 },
    }),
  ]);
  assert.ok(
    decision.reasons.some((r) => r.includes("4 recompute failure(s) across 1 run(s)")),
    `reasons: ${decision.reasons.join("; ")}`
  );
});
