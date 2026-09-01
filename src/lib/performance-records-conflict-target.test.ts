/**
 * performance_records conflict-target contract (2026-09-01 regression).
 *
 * Migration 093 replaced the two-column unique key on performance_records
 * with UNIQUE (employee_id, report_period_id, location_id) — the location
 * axis — while the recompute upsert kept naming the dropped pair. Every
 * recompute in the app failed for a full nightly cycle ("no unique or
 * exclusion constraint matching the ON CONFLICT specification"), 329 of the
 * 416 failures inside status:'success' runs. No test pinned the conflict
 * target, so nothing caught it.
 *
 * Three pins, per the repo's text-level contract convention
 * (frozen-quarter-guard.test.ts, sales-gap-contract.test.ts):
 *  1. The upsert names the three-column target exactly.
 *  2. The no-conjuring existence read is location-scoped — without
 *     .eq("location_id") it throws on the first legitimate two-store
 *     employee (PGRST116) and, worse, conjures all-null rows at stores
 *     where the employee has no activity.
 *  3. The conflict target matches the constraint's columns AS DECLARED IN
 *     THE MIGRATION — parsed from 093, not restated by hand, so the next
 *     migration that moves the constraint breaks this test instead of prod.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const recomputeSrc = read("src/lib/performance-recompute.ts");
const migrationSrc = read(
  "supabase/migrations/093_performance_records_location_axis.sql"
);

test("the performance_records upsert names the three-column conflict target exactly", () => {
  assert.match(
    recomputeSrc,
    /onConflict: "employee_id,report_period_id,location_id"/
  );
  // And never the pre-093 pair on its own — the dropped key must not creep back.
  assert.doesNotMatch(
    recomputeSrc,
    /onConflict: "employee_id,report_period_id"\s*\}/
  );
});

test("the no-conjuring existence read is location-scoped", () => {
  const readStart = recomputeSrc.indexOf('const { data: existingRow');
  assert.ok(readStart > 0, "existence read found");
  const readEnd = recomputeSrc.indexOf(".maybeSingle()", readStart);
  assert.ok(readEnd > readStart, "existence read ends in maybeSingle");
  const block = recomputeSrc.slice(readStart, readEnd);
  assert.ok(
    block.includes('.from("performance_records")'),
    "the block located is the performance_records read"
  );
  assert.ok(
    block.includes('.eq("location_id"'),
    "existence read must filter on location_id — without it a two-store " +
      "employee throws PGRST116 and a one-store row conjures all-null rows " +
      "at the other store"
  );
});

test("the conflict target matches the unique constraint's columns as declared in mig 093", () => {
  const constraint = migrationSrc.match(
    /add constraint performance_records_employee_period_location_key\s+unique\s*\(([^)]+)\)/i
  );
  assert.ok(constraint, "mig 093 declares the unique constraint");
  const constraintColumns = constraint[1].split(",").map((c) => c.trim());
  const target = recomputeSrc.match(/onConflict: "([^"]+)"/);
  assert.ok(target, "the upsert names a conflict target");
  assert.deepEqual(
    target[1].split(","),
    constraintColumns,
    "the upsert's ON CONFLICT tuple must be exactly the constraint's column list"
  );
});
