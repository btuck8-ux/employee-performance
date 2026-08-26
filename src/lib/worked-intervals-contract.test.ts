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

test("tz.ts keeps NO copy of the zone map — locations.timezone is the single source", () => {
  // This test used to assert TS↔SQL parity between a hand-maintained map
  // and mig 058's seed. The map is GONE (LOCATION_CODES packet 2026-08-26:
  // do not keep a copy of anything the database owns) — the property now
  // pinned is its absence, plus the loud fallback: a store with no
  // locations.timezone THROWS instead of guessing (the old warn-and-default
  // made FCCSU correct by coincidence of being a Denver store).
  assert.doesNotMatch(tzSrc, /America\/(Denver|Chicago)/, "no hardcoded zones in tz.ts");
  assert.match(tzSrc, /export function storeTimezone/);
  assert.match(tzSrc, /throw new Error/, "missing zone throws");
  assert.doesNotMatch(tzSrc, /console\.warn/, "no warn-and-guess fallback");
  // mig 058 remains the historical record that seeded the column.
  assert.match(migSrc, /add column if not exists timezone text not null default 'America\/Denver'/);
});

test("the split is GO-LIVE-DATED, not all-or-nothing per store — and a null go-live loses nothing", () => {
  // Pre-go-live history at Toast stores exists only in time_entries;
  // Houston's Q2 2026 straddles its 2026-04-30 go-live. A GUID store with
  // no go-live yet keeps its time_entries history (Codex blocker: the
  // two-sided date test would otherwise drop the store entirely).
  assert.match(
    migSrc,
    /or te\.entry_date < cfg\.go_live/,
    "time_entries side must admit Toast stores' pre-go-live rows"
  );
  assert.match(migSrc, /or cfg\.go_live is null/, "null go-live keeps the time_entries path");
  assert.match(
    migSrc,
    /tte\.entry_date >= cfg\.go_live/,
    "Toast side must start at the store's own go-live"
  );
});

test("store config rides a definer-rights config view — a locations join would drop user-tier self reads", () => {
  // locations_read grants only epd_authorized_location_ids(), empty for the
  // user tier; a security_invoker join to locations would silently drop a
  // self-only viewer's OWN intervals. The config view exposes exactly three
  // config columns; row protection stays on the source tables.
  assert.match(migSrc, /create or replace view public\.v_location_flip_config/);
  assert.match(migSrc, /join public\.v_location_flip_config cfg/);
  // Neither union side may join locations directly.
  const between = migSrc.slice(
    migSrc.indexOf("create or replace view public.v_worked_intervals"),
    migSrc.indexOf("comment on view public.v_worked_intervals")
  );
  assert.doesNotMatch(between, /join public\.locations/);
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

test("EMPLOYEE-TIER ISOLATION (non-negotiable, addendum 2 §5): both disjuncts, self-only by policy shape", () => {
  // epd_authorized_location_ids() returns '{}' for the user tier, so the
  // purview disjunct can never match for them — only self remains. That
  // isolation is a property of the POLICY SHAPE: a purview-only policy
  // would break self-service for the user tier; a self-only policy would
  // break every manager surface. Both disjuncts must survive every future
  // change to these tables.
  for (const table of ["toast_time_entries", "seven_shifts_shifts"] as const) {
    const policy = migSrc.slice(migSrc.indexOf(`create policy ${table}_read`));
    const head = policy.slice(0, policy.indexOf(";"));
    assert.match(
      head,
      /location_id = any \(\(select public\.epd_authorized_location_ids\(\)\)::uuid\[\]\)/,
      `${table}_read must carry the purview disjunct`
    );
    assert.match(
      head,
      /or employee_id = \(select public\.epd_self_employee_id\(\)\)/,
      `${table}_read must carry the self disjunct`
    );
  }
});

test("column grants (addendum 2 §1): raw is NEVER granted; only what the surfaces consume", () => {
  // toast_time_entries.raw carries the entire Toast payload (hourlyWage,
  // declared/nonCash tips, sales, breaks). RLS is row-level; this exposure
  // is column-level.
  assert.match(migSrc, /revoke select on public\.toast_time_entries from authenticated/);
  assert.match(migSrc, /revoke select on public\.seven_shifts_shifts from authenticated/);
  const grants = migSrc.match(/grant select \(([\s\S]*?)\) on public\.(toast_time_entries|seven_shifts_shifts) to authenticated/g) ?? [];
  assert.equal(grants.length, 2, "one column-list grant per narrowed table");
  for (const g of grants) {
    assert.ok(!/\braw\b/.test(g), "raw must never appear in a grant list");
  }
  // The view's inputs stay granted — the metric must keep working.
  assert.match(grants[0], /in_at, out_at, regular_hours, overtime_hours/);
  assert.match(grants[1], /entry_date, start_at/);
});

test("v_location_flip_config exposes exactly its three config columns and nothing else", () => {
  const def = migSrc.slice(
    migSrc.indexOf("create or replace view public.v_location_flip_config"),
    migSrc.indexOf("comment on view public.v_location_flip_config")
  );
  assert.match(def, /\(l\.toast_restaurant_guid is not null\) as is_toast/);
  assert.match(def, /l\.toast_sales_start_date\s+as go_live/);
  assert.match(def, /l\.timezone\s+as tz/);
  // Nothing sensitive rides along: no name, no aliases, no tokens, and the
  // select list is exactly four output columns (location_id + the three).
  const selects = def.match(/\bas \w+/g) ?? [];
  assert.equal(selects.length, 4, "location_id, is_toast, go_live, tz — and nothing else");
});
