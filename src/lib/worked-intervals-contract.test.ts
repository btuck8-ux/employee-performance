/**
 * Contract pins for mig 058 — the flip's SQL side (addendum §3, 2026-08-25).
 * TEXT-LEVEL pins per repo convention.
 *
 * v_worked_intervals is THE single worked-time source: Toast stores read
 * toast_time_entries on/after their own go-live, everything else (NOLA +
 * every store's pre-go-live history) reads time_entries. These pins hold
 * the four load-bearing properties: the go-live date split (Houston's Q2
 * straddles 2026-04-30 — April presence lives only in time_entries), the
 * pay-bucket hours semantics (a span would silently include unpaid
 * breaks), the single-reader rule (no re-emitted function may read
 * time_entries worked rows directly), and the RLS widening (SA-only reads
 * on the source tables would make every metric viewer-dependent).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const migSrc = read("supabase/migrations/058_worked_intervals_flip.sql");
const tzSrc = read("src/lib/ingest/sevenshifts/tz.ts");
const tisSrc = read("src/lib/total-impact-score.ts");

test("locations.timezone mirrors tz.ts exactly — TS↔SQL parity", () => {
  // tz.ts: NOLA + HOU are America/Chicago; the six CO stores America/Denver.
  const chicago = [...tzSrc.matchAll(/(\w+): "America\/Chicago"/g)].map((m) => m[1]).sort();
  assert.deepEqual(chicago, ["HOU", "NOLA"], "tz.ts Chicago set changed — update mig 058");
  assert.match(migSrc, /add column if not exists timezone text not null default 'America\/Denver'/);
  assert.match(migSrc, /location_code in \('HOU', 'NOLA'\)/);
  assert.match(migSrc, /set timezone = 'America\/Chicago'/);
});

test("the split is GO-LIVE-DATED, not all-or-nothing per store", () => {
  // Pre-go-live history at Toast stores exists only in time_entries;
  // Houston's Q2 2026 straddles its 2026-04-30 go-live.
  assert.match(
    migSrc,
    /or te\.entry_date < l\.toast_sales_start_date/,
    "time_entries side must admit Toast stores' pre-go-live rows"
  );
  assert.match(
    migSrc,
    /tte\.entry_date >= l\.toast_sales_start_date/,
    "Toast side must start at the store's own go-live"
  );
});

test("hours keep pay-bucket semantics on both sides — never bare spans for eligibility/weights", () => {
  assert.match(migSrc, /coalesce\(te\.regular_hours,\s+0\)/);
  assert.match(migSrc, /coalesce\(tte\.regular_hours, 0\) \+ coalesce\(tte\.overtime_hours, 0\)/);
  // 025's eligibility CTE + 026's two hours CTEs all sum the view's hours.
  const bucketSums = migSrc.match(/sum\(w\.hours\)/g) ?? [];
  assert.equal(bucketSums.length, 3, "hours_by_emp + hours_all_time + hours_in_quarter sum w.hours");
});

test("v_worked_intervals is the ONLY reader of time_entries worked rows in mig 058", () => {
  const workedReads = migSrc.match(/entry_type\s*=\s*'worked'/g) ?? [];
  assert.equal(
    workedReads.length,
    1,
    "exactly one worked-row read — the view itself; every function reads the view"
  );
  for (const fn of [
    "compute_employee_tip_metrics",
    "recompute_team_tip_impact",
    "compute_employee_hourly_tip_rate",
    "compute_tis_rankings_for_quarter",
    "compute_location_cs_score",
  ]) {
    assert.match(migSrc, new RegExp(`create or replace function public\\.${fn}`), `${fn} re-emitted`);
  }
  assert.match(migSrc, /join public\.v_worked_intervals/);
});

test("RLS: source tables widen to the time_entries classification — metrics must not be viewer-dependent", () => {
  // security_invoker view + invoker-rights functions + session clients:
  // under 054/055's SA-only reads a manager would silently compute zero
  // hours and empty presence at Toast stores.
  assert.match(migSrc, /create policy toast_time_entries_read on public\.toast_time_entries/);
  assert.match(migSrc, /create policy seven_shifts_shifts_read on public\.seven_shifts_shifts/);
  const class1 = migSrc.match(
    /location_id = any \(\(select public\.epd_authorized_location_ids\(\)\)::uuid\[\]\)\s*\n\s*or employee_id = \(select public\.epd_self_employee_id\(\)\)/g
  ) ?? [];
  assert.equal(class1.length, 2, "both policies use 047's Class-1 direct form");
});

test("TS side reads the same view — fetchAllTimeWorkedHours parity by construction", () => {
  assert.match(tisSrc, /from\("v_worked_intervals"\)/);
  assert.doesNotMatch(
    tisSrc,
    /from\("time_entries"\)/,
    "TIS eligibility must not read time_entries directly once the SQL side reads the view"
  );
});

test("kitchen speed is deliberately NOT rewired (role-equivalence is an open Tucker decision)", () => {
  assert.doesNotMatch(migSrc, /create or replace function public\.compute_kitchen_speed/);
  assert.match(migSrc, /DELIBERATELY NOT REWIRED/);
});

test("the migration declares itself apply-WITH-the-flip — it moves published numbers", () => {
  assert.match(migSrc, /applied WITH the flip PR, not before/);
});
