/**
 * Contract pins for the scoped recompute lever (recompute-lever spec
 * 2026-08-25, Build 1) — TEXT-LEVEL pins per repo convention.
 *
 * The lever exists because staleness must be closed WITH a report —
 * unobserved correctness is indistinguishable from unobserved error. Its
 * charter: scope plus a report, nothing more; the recompute path itself is
 * runRecomputeJobs verbatim, never forked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const routeSrc = read("src/app/api/admin/recompute-quarter/route.ts");

test("dry-run is the default; the report returns BEFORE any write path", () => {
  assert.match(routeSrc, /searchParams\.get\("write"\) === "1"/);
  const body = routeSrc.indexOf("export async function GET");
  const dryReturn = routeSrc.indexOf("if (!write)", body);
  const writeCall = routeSrc.indexOf("runRecomputeJobs(", body);
  assert.ok(
    dryReturn > 0 && writeCall > 0 && dryReturn < writeCall,
    "the dry-run return must precede the write"
  );
});

test("write requires confirm_quarters; pre-2026 quarters require override_frozen_quarter — both named exactly", () => {
  assert.match(routeSrc, /confirm_quarters/);
  assert.match(routeSrc, /year < 2026/);
  assert.match(routeSrc, /override_frozen_quarter/);
  // Both guards precede the write in the GET body.
  const body = routeSrc.indexOf("export async function GET");
  const frozen = routeSrc.indexOf("override_frozen_quarter", body);
  const confirm = routeSrc.indexOf('searchParams.get("confirm_quarters")', body);
  const writeCall = routeSrc.indexOf("runRecomputeJobs(", body);
  assert.ok(frozen > 0 && frozen < writeCall, "frozen guard precedes the write");
  assert.ok(confirm > 0 && confirm < writeCall, "confirm guard precedes the write");
  // Explicit params, never defaulted to "current".
  assert.doesNotMatch(routeSrc, /currentQuarter\(/);
});

test("the recompute path is runRecomputeJobs VERBATIM — scope plus a report, never a fork", () => {
  assert.match(routeSrc, /runRecomputeJobs\(/);
  // The lever itself writes nothing to performance_records; the only
  // writer is the shared job runner.
  assert.doesNotMatch(routeSrc, /from\("performance_records"\)[\s\S]{0,200}upsert/);
  // The "after" side is the PURE compute — dry_run persists nothing.
  assert.match(routeSrc, /computeMetricsForRange\(/);
});

test("one location per invocation — no estate-wide fan-out", () => {
  assert.match(routeSrc, /eq\("location_code", locationCode\)/);
  assert.doesNotMatch(routeSrc, /loadToastLaborLocations|not\("toast_restaurant_guid"/);
});

test("the report is the deliverable: per-employee before/after + the summary blocks", () => {
  for (const field of [
    "before",
    "after",
    "delta_attendance_pp",
    "scheduled_days",
    "worked_days",
    "null_reason",
    "employees_touched",
    "attendance_movers_over_10pp",
    "became_null",
    "store_attendance_day_weighted",
  ]) {
    assert.match(routeSrc, new RegExp(field), `report must carry ${field}`);
  }
  // The before-side weighting approximation is stated, not hidden (§7).
  assert.match(routeSrc, /before_note/);
  assert.match(routeSrc, /pre-flip counts were not persisted/);
});
