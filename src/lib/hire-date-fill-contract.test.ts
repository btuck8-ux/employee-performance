/**
 * Pins for the hire-date NULL-fill (kickoff 2026-08-17 §3, Tucker §6-B
 * ruling). Three invariants worth freezing at the text level:
 *
 *  1. NEVER-OVERWRITE — the fill selects only NULL hire_dates AND re-guards
 *     the update with .is("hire_date", null), so a concurrent manual edit
 *     always wins and existing dates are untouchable.
 *  2. WORKED-ONLY — the source is entry_type='worked'; scheduled rows must
 *     never become hire dates ("first shift they worked", not "first shift
 *     on the schedule").
 *  3. WIRING — the operator route is CRON_SECRET-gated and the nightly cron
 *     runs the same fill non-fatally (a fill failure can't fail the ingest).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const fill = read("src/lib/hire-date-fill.ts");
const adminRoute = read("src/app/api/admin/backfill-hire-dates/route.ts");
const nightly = read("src/app/api/cron/nightly-ingest/route.ts");

test("fill scans only NULL hire dates and re-guards the update (never-overwrite)", () => {
  // Scan: employees with NULL hire_date only.
  assert.match(
    fill,
    /\.from\("employees"\)[\s\S]*?\.is\("hire_date", null\)/,
    "employee scan filters to NULL hire_date"
  );
  // Update: touches only hire_date, and only while it is still NULL.
  const update = fill.match(
    /\.from\("employees"\)\s*\.update\(([\s\S]*?)\)[\s\S]*?\.select\("id"\)/
  );
  assert.ok(update, "guarded update present");
  assert.match(update![0], /\.update\(\{ hire_date: hireDate \}\)/, "update writes hire_date only");
  assert.match(update![0], /\.is\("hire_date", null\)/, "update re-guards on NULL (race-safe)");
});

test("fill sources the earliest WORKED entry — scheduled rows never count", () => {
  const readQ = fill.match(/\.from\("time_entries"\)[\s\S]*?\.limit\(1\)/);
  assert.ok(readQ, "time_entries read present");
  assert.match(readQ![0], /\.eq\("entry_type", "worked"\)/, "worked-only filter");
  assert.match(
    readQ![0],
    /\.order\("entry_date", \{ ascending: true \}\)/,
    "earliest-first order"
  );
  assert.doesNotMatch(fill, /"scheduled"/, "no scheduled fallback anywhere in the fill");
});

test("operator route is CRON_SECRET-gated and calls the shared fill", () => {
  assert.match(
    adminRoute,
    /requireBearer\(request, process\.env\.CRON_SECRET, "CRON_SECRET"\)/,
    "bearer gate"
  );
  assert.match(adminRoute, /fillMissingHireDates\(/, "calls the shared fill");
  assert.match(
    adminRoute,
    /from "@\/lib\/hire-date-fill"/,
    "single shared implementation — no route-local copy"
  );
});

test("nightly cron runs the fill non-fatally after the ingest", () => {
  assert.match(nightly, /fillMissingHireDates\(/, "nightly calls the fill");
  const afterIngest =
    nightly.indexOf("runNightlyIngest()") < nightly.indexOf("fillMissingHireDates(");
  assert.ok(afterIngest, "fill runs after the ingest fan-out");
  // The fill sits in its own try/catch so it can never 500 the cron.
  assert.match(
    nightly,
    /try \{\s*const fill = await fillMissingHireDates[\s\S]*?\} catch \(fillErr\)/,
    "fill wrapped non-fatally"
  );
});
