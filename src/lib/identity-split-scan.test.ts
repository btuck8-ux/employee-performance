/**
 * Pin: Scan B — the identity-split detector (epd_role spec 2026-08-26 §8a)
 * + unit tests for the report shaping.
 *
 * ⚠️ The FIRST-NAME match arm is load-bearing: Nicholas Tolan / Nicholas
 * Tolson — the only real split in the estate — matches on the first name
 * alone. A surname-only detector would miss the only true positive while
 * returning every genuine pair of colleagues (Turners, Beckers, Hardings,
 * Griffins) — the exact inversion of its purpose. This pin keeps that arm
 * from ever being "simplified" away.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSplitReport,
  formatHitLines,
  SPLIT_PAIR_BASELINE,
  type SplitScanRow,
} from "./identity-split-scan.ts";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/073_identity_split_scan.sql"),
  "utf8"
);

test("all three match arms present — first name is NOT optional (Tolan/Tolson)", () => {
  assert.match(migration, /a\.last_name = b\.last_name/);
  assert.match(migration, /a\.first_name = b\.first_name/);
  assert.match(migration, /left\(a\.last_name, 4\) = left\(b\.last_name, 4\)/);
});

test("punch evidence rides v_worked_intervals — the era-correct union, never raw punches", () => {
  assert.match(migration, /from public\.v_worked_intervals/);
});

test("schedule evidence: scheduled mirror rows + the pruned direct feed", () => {
  assert.match(migration, /entry_type = 'scheduled'/);
  assert.match(migration, /missing_upstream_since is null/);
});

test("each pair counted once, in-store only — the THQ 20→19 double-count made impossible", () => {
  assert.match(migration, /a\.id < b\.id/);
  assert.match(migration, /a\.location_id = b\.location_id/);
});

test("weekly cron scheduled clear of the ingest + GH-Action windows", () => {
  const vercel = JSON.parse(
    readFileSync(join(process.cwd(), "vercel.json"), "utf8")
  ) as { crons: { path: string; schedule: string }[] };
  const cron = vercel.crons.find(
    (c) => c.path === "/api/cron/identity-split-scan"
  );
  assert.ok(cron, "cron entry exists");
  assert.equal(cron!.schedule, "0 12 * * 1");
});

// ── report shaping (pure) ───────────────────────────────────────────────────

function row(overrides: Partial<SplitScanRow>): SplitScanRow {
  return {
    location_code: "NOLA",
    employee_code_a: "EMP-100178",
    employee_name_a: "Nicholas Tolan",
    employee_code_b: "EMP-100179",
    employee_name_b: "Nicholas Tolson",
    match_basis: "first",
    punches_a: 27,
    scheduled_a: 0,
    punches_b: 0,
    scheduled_b: 22,
    is_hit: true,
    ...overrides,
  };
}

test("report carries ONLY hits; the pair list never leaves the DB layer", () => {
  const rows = [row({}), row({ is_hit: false, employee_name_a: "Davida Turner" })];
  const report = buildSplitReport(rows);
  assert.equal(report.hit_count, 1);
  assert.equal(report.hits.length, 1);
  assert.equal(report.hits[0].employee_name_a, "Nicholas Tolan");
});

test("pair count rides as drift metadata against the agreed baseline", () => {
  assert.equal(SPLIT_PAIR_BASELINE, 19);
  const rows = Array.from({ length: 20 }, (_, i) =>
    row({ is_hit: false, employee_code_a: `EMP-${i}` })
  );
  const report = buildSplitReport(rows);
  assert.equal(report.pair_count, 20);
  assert.equal(report.pair_drift, 1); // a drift of one is the readable signal
});

test("hit lines carry employee codes — a memo naming a person carries the code or it is not sendable", () => {
  const lines = formatHitLines([row({})]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /EMP-100178/);
  assert.match(lines[0], /EMP-100179/);
  assert.match(lines[0], /27p\/0s/);
  assert.match(lines[0], /0p\/22s/);
});
