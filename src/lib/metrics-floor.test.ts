/**
 * THE DEMARCATION FLOOR — pins for the 2026-08-26 packet.
 *
 * "The date Toast comes on line is the date that data starts." A FLOOR, not
 * a delete: labor-derived metrics are computed only from entry dates >=
 * locations.metrics_start_date; days below are outside the measured window
 * exactly as a future date is — not absent, not zero, in no denominator.
 * NULL floor = no floor (NOLA — ruled; never read as epoch or today).
 *
 *  TEXT PINS ONLY — the behavioural unit tests for the floor opt live in
 *  performance-recompute.test.ts, which carries the module-resolution hook
 *  performance-recompute.ts needs (extensionless + alias imports).
 *
 *  - Text pins on migs 066/067: seed shape, view re-emission, the SQL-side
 *    floor clamp in the tip functions, the GM exclusion's reach (location
 *    side only), and floor-not-wipe (no source-table deletes).
 *  - §1d: the outbound feeds are NOT gated — THQ's frozen-quarter
 *    fingerprints (Q3 2025 = 160 rows, Q4 2025 = 178) live below every
 *    floor and must keep being served. Pinned structurally here; the live
 *    row counts are asserted against /api/scores after deploy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Text pins — migrations and threading.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const mig066 = read("supabase/migrations/066_metrics_start_date_floor.sql");
const mig067 = read("supabase/migrations/067_location_tip_baseline_excludes_gms.sql");
const recomputeSrc = read("src/lib/performance-recompute.ts");
const flipSrc = read("src/lib/flip-entries.ts");
const storeSrc = read("src/lib/store-attendance.ts");

test("mig 066: column + guarded seed + null-is-no-floor stated in the column comment", () => {
  assert.match(mig066, /add column if not exists metrics_start_date date/);
  // Seed only where a Toast identity AND a go-live exist — NOLA stays null.
  assert.match(mig066, /toast_restaurant_guid is not null/);
  assert.match(mig066, /toast_sales_start_date is not null/);
  assert.match(mig066, /NULL = no floor/);
  assert.match(mig066, /never read null as epoch or today/);
});

test("mig 066: v_location_flip_config re-emitted with metrics_start as the FOURTH config column", () => {
  const def = mig066.slice(
    mig066.indexOf("create or replace view public.v_location_flip_config"),
    mig066.indexOf("comment on view public.v_location_flip_config")
  );
  assert.match(def, /l\.metrics_start_date\s+as metrics_start/);
  const selects = def.match(/\bas \w+/g) ?? [];
  assert.equal(
    selects.length,
    5,
    "location_id, is_toast, go_live, tz, metrics_start — and nothing else"
  );
});

test("mig 066: both SQL tip functions clamp to the floor (TS↔SQL lockstep for the labor window)", () => {
  // compute_employee_tip_metrics: floor_cfg CTE with greatest(...).
  assert.match(mig066, /floor_cfg as \(/);
  assert.match(
    mig066,
    /greatest\(\s*p_period_start,\s*coalesce\(l\.metrics_start_date, p_period_start\)\s*\)/
  );
  // recompute_team_tip_impact: plpgsql clamp + empty-window early return.
  assert.match(mig066, /if v_floor is not null and v_floor > v_period_start then/);
  assert.match(mig066, /if v_window_start >= v_window_end then/);
});

test("FLOOR, NOT A WIPE: mig 066 deletes nothing from any source or scoring table", () => {
  const deletes: string[] = mig066.match(/delete from public\.(\w+)/g) ?? [];
  // team_tip_impact's delete is the function's pre-existing idempotent
  // rebuild of its OWN derived slice — the only delete allowed here.
  assert.deepEqual([...new Set(deletes)], ["delete from public.team_tip_impact"]);
  for (const tbl of [
    "time_entries",
    "toast_time_entries",
    "seven_shifts_shifts",
    "performance_records",
    "employees",
  ]) {
    assert.ok(
      !deletes.includes(`delete from public.${tbl}`),
      `${tbl} must never be deleted from`
    );
  }
});

test("mig 067: GM exclusion reaches ONLY the location side of the tip math", () => {
  assert.match(mig067, /worked_nongm as \(/);
  assert.match(mig067, /is_general_manager is distinct from true/);
  // Location-side reads switch to worked_nongm…
  assert.match(mig067, /from worked_nongm w cross join window_bounds wb/);
  assert.match(mig067, /select 1 from worked_nongm w/);
  // …while the employee side still reads the unfiltered set (a GM's own
  // row still computes from their own punches — the ruling accepts that;
  // the >16h flag is what surfaces the bad rows).
  assert.match(mig067, /join worked w\s+on w\.employee_id = p_employee_id/);
  assert.match(
    mig067,
    /from worked w cross join window_bounds wb\s+where w\.employee_id = p_employee_id/
  );
});

test("threading: the floor rides FlipLocationMeta and reaches all three compute entry points", () => {
  assert.match(flipSrc, /metricsStart: string \| null/);
  assert.match(flipSrc, /select\("is_toast, go_live, tz, metrics_start"\)/);
  // Both recompute entry points and the store card pass the floor into the
  // asset (the guard lives ON computeMetricsFromEntries, not in callers).
  const threaded = recomputeSrc.match(/metricsStartFloor: metricsStart/g) ?? [];
  assert.equal(threaded.length, 2, "computeMetricsForRange + recomputePerformanceForQuarter");
  assert.match(storeSrc, /metricsStartFloor: meta\.metricsStart/);
});

test("no-conjuring stays floor-aware: below-floor entries alone must not mint a performance_records row", () => {
  assert.match(recomputeSrc, /scorableEntryCount/);
  const activityCall = recomputeSrc.indexOf("entry_count: scorableEntryCount");
  assert.ok(activityCall > 0, "periodHasActivity reads the floor-filtered count");
});

test("§2: the clamp is a first-class disclosure — RangeMetrics carries the effective labor window", () => {
  assert.match(recomputeSrc, /labor_window_start: string \| null/);
  assert.match(recomputeSrc, /labor_window_clamped: boolean/);
  // Whole-window-below-floor is NOT ANSWERABLE (null start), never an
  // ordinary empty result.
  assert.match(recomputeSrc, /\? null \/\/ whole window below the floor — not answerable/);
});

// ── mig 080: the floor is NOT NULL, and it gates computation, not retrieval ─

test("080: metrics_start_date is NOT NULL — a nullable clamp column is a silent whole-store outage", () => {
  // `entry_date >= floor` with a NULL floor evaluates NULL and matches
  // NOTHING: NOLA's 20 kept attendance values would have vanished with no
  // error. The meaning must not live inside an absence (ruling 2026-08-26,
  // final). A future migration relaxing this must fail here first.
  const sql080 = read("supabase/migrations/080_nola_floor_not_null.sql");
  assert.match(sql080, /alter column metrics_start_date set not null/);
  assert.match(sql080, /GATES COMPUTATION, '\s*\n\s*'NOT RETRIEVAL/);
  assert.match(sql080, /set metrics_start_date = date '2025-07-01'/);
});

test("080: the floor NEVER filters a read path — the frozen quarters live below every floor", () => {
  // Q3 2025 (119 attendance values) and Q4 2025 (103) sit below EVERY
  // store's floor and are frozen by mig 063. A `>= floor` comparison on
  // the way out blanks all 222 of them — which is why the ruling is
  // phrased computation-versus-retrieval, not as a date filter. No feed
  // route may reference the column at all.
  for (const p of [
    "src/app/api/scores/route.ts",
    "src/app/api/scores/range/route.ts",
    "src/app/api/identity/route.ts",
  ]) {
    assert.doesNotMatch(
      read(p),
      /metrics_start_date/,
      `${p} must not touch the floor column — the floor gates computation, never retrieval`
    );
  }
});
