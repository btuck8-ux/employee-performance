/**
 * Unit tests for the recompute-failure ledger sweep (detector Layer 2).
 *
 *   node --test src/lib/ingest/recompute-sweep.test.ts
 *
 * summarizeSweep()/nextHighWater()/buildSweepBody() are pure; no DB, no fetch.
 *
 * The two day fixtures mirror the measured prod aggregates (spec §1/§4):
 *   known-bad  2026-09-01: 34 success-status runs carrying 329 failures +
 *                          8 error-status runs carrying 87 = 416 total.
 *   known-good 2026-09-02 09:00–10:03Z: zero failures everywhere, INCLUDING
 *                          five 7tasks status='error' runs (the separate pkey
 *                          escalation) the sweep must stay silent about.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeSweep,
  nextHighWater,
  buildSweepBody,
  type SweptRun,
} from "./recompute-sweep.ts";

function row(overrides: Partial<SweptRun>): SweptRun {
  return {
    source: "7shifts_time",
    status: "success",
    started_at: "2026-09-01T09:00:00.000Z",
    detail: null,
    ...overrides,
  };
}

/** n failure entries, with the exact count beside the capped sample. */
function failing(n: number, overrides: Partial<SweptRun> = {}): SweptRun {
  return row({
    detail: {
      recompute_failures: new Array(Math.min(n, 20)).fill({ reason: "upsert failed" }),
      recompute_failure_count: n,
    },
    ...overrides,
  });
}

test("known-bad day (2026-09-01): fires, ≥329 from success runs alone, 416 total", () => {
  const rows: SweptRun[] = [];
  // 34 success-status runs / 329 failures: 17 + 16 + 32 × ~9-ish. Model the
  // worst single run at 17 (the measured max — below the 20 cap, so exact).
  rows.push(failing(17, { source: "cp_schedule" }));
  rows.push(failing(16, { source: "culture_pulse" }));
  for (let i = 0; i < 32; i += 1) {
    rows.push(failing(i < 8 ? 10 : 9, { source: i % 2 ? "7shifts_time" : "toast_sales" }));
  }
  // 8 error-status runs / 87 failures.
  for (let i = 0; i < 8; i += 1) {
    rows.push(failing(i < 7 ? 11 : 10, { status: "error", source: "pos_receipts" }));
  }

  const successTotal = rows
    .filter((r) => r.status === "success")
    .reduce((a, r) => a + (r.detail!.recompute_failure_count as number), 0);
  assert.equal(successTotal, 329, "fixture models the measured success-side count");

  const summary = summarizeSweep(rows);
  assert.equal(summary.shouldAlert, true);
  assert.equal(summary.totalFailures, 416);
  assert.equal(summary.failingRuns, 42);
  assert.equal(summary.exact, true);
  assert.ok(successTotal >= 329, "success-status runs alone carry ≥329");
});

test("known-good day (2026-09-02): stays silent — including five 7tasks error runs with zero recompute failures", () => {
  const rows: SweptRun[] = [
    // Healthy cycle across sources: empty arrays, explicit zero counts, nulls.
    row({ detail: { recompute_failures: [], recompute_failure_count: 0 } }),
    row({ source: "cp_schedule", detail: { recompute_failure_count: 0 } }),
    row({ source: "toast_sales", detail: {} }),
    row({ source: "cake_timesheets", detail: null }),
    // The discrimination case: errored for a DIFFERENT reason (pkey collision).
    ...new Array(5).fill(null).map(() =>
      row({ source: "7tasks", status: "error", detail: { pkey_collisions: 3 } })
    ),
  ];
  const summary = summarizeSweep(rows);
  assert.equal(summary.shouldAlert, false);
  assert.equal(summary.totalFailures, 0);
  assert.equal(summary.failingRuns, 0);
});

test("source-blind: a CAKE success run with 3 failures fires (NOLA's unwired writer, 2026-09-01 17:23Z)", () => {
  const summary = summarizeSweep([
    failing(3, { source: "cake_timesheets", started_at: "2026-09-01T17:23:23.000Z" }),
  ]);
  assert.equal(summary.shouldAlert, true);
  assert.equal(summary.totalFailures, 3);
  assert.deepEqual(summary.groups, [
    { source: "cake_timesheets", status: "success", runs: 1, failures: 3, exact: true },
  ]);
});

test("truncation guard: a legacy row at exactly 20 sampled entries is a lower bound, not an exact 20", () => {
  // No recompute_failure_count (pre-B3 row) and a sample at the cap.
  const summary = summarizeSweep([
    row({ detail: { recompute_failures: new Array(20).fill({}) } }),
  ]);
  assert.equal(summary.shouldAlert, true);
  assert.equal(summary.totalFailures, 20);
  assert.equal(summary.exact, false, "must not report 20 as exact");
  const body = buildSweepBody(summary, "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z");
  assert.match(body, /≥ 20 recompute failure/);
  assert.match(body, /lower bound/);
});

test("truncation guard: with recompute_failure_count present, a capped sample reports the exact integer", () => {
  const summary = summarizeSweep([failing(57)]);
  assert.equal(summary.totalFailures, 57);
  assert.equal(summary.exact, true);
  const body = buildSweepBody(summary, "a", "b");
  assert.match(body, /57 recompute failure/);
  assert.doesNotMatch(body, /≥/);
});

test("legacy rows below the cap count exactly off the sample", () => {
  const summary = summarizeSweep([
    row({ detail: { recompute_failures: [{}, {}, {}] } }),
  ]);
  assert.equal(summary.totalFailures, 3);
  assert.equal(summary.exact, true);
});

test("counting is off detail, never error_text (the 5× undercount)", () => {
  // cp_schedule collapses failures to a summary STRING in error_text; the
  // sweep never reads that column — its select doesn't even fetch it.
  const summary = summarizeSweep([
    row({
      source: "cp_schedule",
      detail: { recompute_failures: [{}, {}, {}, {}], recompute_failure_count: 4 },
    }),
  ]);
  assert.equal(summary.totalFailures, 4);
});

test("still-running rows are not judged and hold the high-water mark back", () => {
  const rows: SweptRun[] = [
    failing(2, { started_at: "2026-09-02T09:10:00.000Z" }),
    row({ status: "running", started_at: "2026-09-02T09:30:00.000Z", detail: null }),
    row({ status: "running", started_at: "2026-09-02T09:20:00.000Z", detail: null }),
  ];
  const summary = summarizeSweep(rows);
  assert.equal(summary.sweptRuns, 1, "running rows are excluded from the judged count");
  assert.equal(summary.totalFailures, 2);

  const now = "2026-09-02T10:00:00.000Z";
  const hw = nextHighWater(now, rows);
  assert.equal(hw, "2026-09-02T09:19:59.999Z", "mark parks just before the earliest running row");
});

test("no running rows → high water advances to now", () => {
  assert.equal(
    nextHighWater("2026-09-02T10:00:00.000Z", [failing(1)]),
    "2026-09-02T10:00:00.000Z"
  );
});

test("groups aggregate per (source, status) for the alert body", () => {
  const summary = summarizeSweep([
    failing(2, { source: "toast_sales" }),
    failing(3, { source: "toast_sales" }),
    failing(5, { source: "toast_sales", status: "error" }),
  ]);
  assert.deepEqual(summary.groups, [
    { source: "toast_sales", status: "error", runs: 1, failures: 5, exact: true },
    { source: "toast_sales", status: "success", runs: 2, failures: 5, exact: true },
  ]);
});
