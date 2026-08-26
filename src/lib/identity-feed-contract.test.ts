/**
 * Pin: the /api/identity wire contract after mig 071 (epd_role spec
 * 2026-08-26 §4/§8).
 *
 * Live consumers poll this daily (CulturePulse 08:45 UTC); the shape is a
 * cross-project contract and additive-only. Mig 071 moved where
 * is_general_manager's truth lives (derived from epd_role = 'manager')
 * WITHOUT changing its name, type, or semantics, and appended epd_role as
 * column 11 — the shared five-value tier vocabulary partners adopt off the
 * wire. ⚠️ Naming hazard, stated so nobody wires the wrong table:
 * 'manager' on employees.epd_role means GENERAL MANAGER; users.role also
 * holds a 'manager' that is a legacy app permission. The derived field
 * reads the employment one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = join(
  process.cwd(),
  "supabase/migrations/071_epd_role_authoritative.sql"
);
const ROUTE = join(process.cwd(), "src/app/api/identity/route.ts");

/** The 11 wire columns in locked order — 10 from mig 068 + epd_role. */
const CONTRACT_COLUMNS = [
  "employee_code",
  "employee_name",
  "location_code",
  "seven_shifts_user_id",
  "email",
  "active",
  "archived_at",
  "updated_at",
  "punches_time_clock",
  "is_general_manager",
  "epd_role",
];

function extractViewColumns(sql: string): string[] {
  const viewMatch = sql.match(
    /create or replace view public\.v_employee_identity[\s\S]*?as\nselect\n([\s\S]*?)\nfrom public\.employees/
  );
  assert.ok(viewMatch, "view definition found in migration 071");
  const body = viewMatch![1];
  const cols: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/as (\w+),?\s*(?:--.*)?$/);
    if (m) cols.push(m[1]);
  }
  return cols;
}

test("identity feed serves exactly the 11 contract columns, locked order", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  assert.deepEqual(extractViewColumns(sql), CONTRACT_COLUMNS);
});

test("is_general_manager is DERIVED from the authoritative tier — same wire name", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  assert.match(
    sql,
    /\(e\.epd_role = 'manager'\) as is_general_manager/,
    "derived expression present"
  );
  assert.doesNotMatch(
    sql,
    /e\.is_general_manager\s+as is_general_manager/,
    "the view no longer reads the stored flag"
  );
});

test("mig 071 does NOT drop the stored is_general_manager column (partners mid-flight)", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  assert.doesNotMatch(sql, /drop\s+column/i);
});

test("epd_role is appended LAST — additive-only feed doctrine", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const cols = extractViewColumns(sql);
  assert.equal(cols[cols.length - 1], "epd_role");
});

test("security_invoker carried over verbatim", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  assert.match(
    sql,
    /create or replace view public\.v_employee_identity\nwith \(security_invoker = true\)/
  );
});

test("route still serves select('*') under the scores-feed bearer — wire gains columns on view apply", () => {
  const src = readFileSync(ROUTE, "utf8");
  assert.match(src, /from\("v_employee_identity"\)\.select\("\*"/);
  assert.match(src, /SCORES_FEED_TOKEN/);
});
