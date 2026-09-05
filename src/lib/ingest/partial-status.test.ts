/**
 * W7 — `partial` run status (MASTER sprint). The ruled invariant, the
 * behaviour matrix across every consumer, and above all the DISABLED-STATE
 * proofs: until activation the entire feature is byte-inert.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyPartialPolicy,
  partialStatusEnabled,
} from "./sevenshifts/runs.ts";
import { countLeadingEmpty } from "./sevenshifts/streak.ts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
// Next's env typing marks NODE_ENV required; these are policy-input stubs.
const OFF = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
const ON = { NODE_ENV: "test", INGEST_PARTIAL_STATUS_ENABLED: "1" } as NodeJS.ProcessEnv;

function outcome(o: {
  status: "running" | "success" | "empty" | "error" | "partial";
  rows_upserted?: number;
  detail?: Record<string, unknown> | null;
}) {
  return {
    status: o.status,
    rows_upserted: o.rows_upserted ?? 0,
    detail: o.detail ?? null,
  };
}

// ---- the activation mechanism is an explicit runtime flag ----

test("the disable mechanism is the INGEST_PARTIAL_STATUS_ENABLED flag — not a schedule", () => {
  assert.equal(partialStatusEnabled(OFF), false);
  assert.equal(partialStatusEnabled({ NODE_ENV: "test", INGEST_PARTIAL_STATUS_ENABLED: "0" } as NodeJS.ProcessEnv), false);
  assert.equal(partialStatusEnabled(ON), true);
});

// ---- DISABLED state: byte-identical behaviour ----

test("flag off: every status passes through byte-identically — no producer can emit partial", () => {
  for (const o of [
    outcome({ status: "success", rows_upserted: 300, detail: { recompute_failure_count: 1, recompute_failures: ["team aggregation 2026-Q3: timeout"] } }),
    outcome({ status: "success", rows_upserted: 0 }),
    outcome({ status: "error", rows_upserted: 5, detail: { recompute_failure_count: 2 } }),
    outcome({ status: "empty" }),
  ]) {
    assert.deepEqual(applyPartialPolicy(o, OFF), o);
  }
});

// ---- ENABLED state: the exact producer condition ----

test("flag on: rows landed + terminal in-run failures → partial (the FCCSU pattern)", () => {
  const fccsu = outcome({
    status: "success",
    rows_upserted: 300,
    detail: { recompute_failure_count: 1, recompute_failures: ["team aggregation 2026-Q3: canceling statement due to statement timeout"] },
  });
  assert.equal(applyPartialPolicy(fccsu, ON).status, "partial");
});

test("flag on: error/empty are never rewritten; clean successes never are; zero-upsert failures stay non-partial", () => {
  assert.equal(applyPartialPolicy(outcome({ status: "error", rows_upserted: 9, detail: { recompute_failure_count: 3 } }), ON).status, "error");
  assert.equal(applyPartialPolicy(outcome({ status: "empty" }), ON).status, "empty");
  assert.equal(applyPartialPolicy(outcome({ status: "success", rows_upserted: 50, detail: { recompute_failure_count: 0 } }), ON).status, "success");
  // No rows durably written → not "partial progress", the failure story is
  // the run-level one.
  assert.equal(applyPartialPolicy(outcome({ status: "success", rows_upserted: 0, detail: { recompute_failure_count: 1 } }), ON).status, "success");
  // Counting rides detail (the sampled-array fallback), never error_text.
  assert.equal(applyPartialPolicy(outcome({ status: "success", rows_upserted: 10, detail: { recompute_failures: ["x"] } }), ON).status, "partial");
});

// ---- BEHAVIOUR MATRIX: every consumer, pinned ----

const runsSrc = read("src/lib/ingest/sevenshifts/runs.ts");
const alertSrc = read("src/lib/ingest/sevenshifts/alert.ts");
const punchRouteSrc = read("src/app/api/identity/punch-days/route.ts");
const cpOrchSrc = read("src/lib/ingest/culture-pulse/orchestrator.ts");
const departureSrc = read("src/app/api/admin/departure-candidates/route.ts");
const punchLibSrc = read("src/lib/punch-days.ts");

test("MATRIX watermark: lastSuccessfulWindowEnd advances on EXACTLY success|empty — partial re-pulls the window", () => {
  assert.match(runsSrc, /\.in\("status", \["success", "empty"\]\)/);
  // and nothing widened it to include partial
  assert.doesNotMatch(runsSrc, /\.in\("status", \[[^\]]*"partial"/);
});

test("MATRIX alerting: partial ALERTS — the both-or-neither invariant is structural", () => {
  assert.match(alertSrc, /r\.status === "partial"/);
  assert.match(alertSrc, /PARTIAL — rows landed but part of the run's own work plan failed/);
});

test("MATRIX empty-streak: partial is not empty (breaks a streak) and not a last-success", () => {
  // countLeadingEmpty counts only 'empty'; partial terminates the streak.
  assert.equal(countLeadingEmpty(["empty", "empty", "empty"] as never), 3);
  assert.equal(countLeadingEmpty(["empty", "partial", "empty"] as never), 1);
  assert.equal(countLeadingEmpty(["partial", "empty"] as never), 0);
});

test("MATRIX staleness + departure freshness: anchored on status='success' only — partial refreshes neither", () => {
  assert.match(cpOrchSrc, /\.eq\("status", "success"\)/);
  assert.match(departureSrc, /\.eq\("source", "cp_schedule"\)\s*\n?\s*\.eq\("status", "success"\)/);
});

test("MATRIX punch-days (the hard case): coverage advances on full success ONLY; partial rides an additive optional field", () => {
  // The existing coverage read keys on status='success' — its meaning is
  // untouched, so an existing CP consumer that ignores completeness keeps
  // pruning exactly what it prunes today.
  assert.match(punchRouteSrc, /\.eq\("source", source\)\s*\n?\s*\.eq\("status", "success"\)/);
  assert.doesNotMatch(punchRouteSrc, /"partial"/);
  // The additive field exists, optional, with the three wire examples.
  assert.match(punchLibSrc, /partial_observed_through\?: string/);
  assert.match(punchLibSrc, /NEVER moves coverage_through/);
  assert.match(punchLibSrc, /partial-only history/);
  assert.match(punchLibSrc, /success then partial/);
  assert.match(punchLibSrc, /eventual successful retry/);
});

test("MATRIX recompute sweep: judges rows status-blind — partial rows are swept like any finished run", () => {
  const sweepSrc = read("src/lib/ingest/recompute-sweep.ts");
  assert.match(sweepSrc, /row\.status === "running"/); // only running is deferred
  assert.doesNotMatch(sweepSrc, /status === "partial"/);
});

// ---- the migration: exists, correct, and NOT wired to anything ----

test("mig 095: widens the constraint to include partial, and states the deployment order (constraint FIRST)", () => {
  const mig = read("supabase/migrations/095_ingest_runs_partial_status.sql");
  assert.match(mig, /check \(status in \('running', 'success', 'empty', 'error', 'partial'\)\)/);
  assert.match(mig, /NOT YET APPLIED TO PRODUCTION/);
  assert.match(
    mig,
    /database must accept `partial` before any deployed producer can[\s-]*\n?[\s-]*emit it/
  );
  assert.match(mig, /INGEST_PARTIAL_STATUS_ENABLED/);
});

test("producer wiring: the toast orchestrator routes through applyPartialPolicy", () => {
  const orchSrc = read("src/lib/ingest/toast/orchestrator.ts");
  assert.match(orchSrc, /applyPartialPolicy\(/);
});
