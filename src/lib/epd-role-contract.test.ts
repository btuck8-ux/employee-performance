/**
 * Pin: mig 071 — employees.epd_role as the authoritative user tier
 * (spec 2026-08-26).
 *
 * The load-bearing pieces, each ruled and none re-derivable from code:
 *   §1 the lockout guard — a login with NO employee row keeps its own
 *      grant (all three live logins are that shape; a strict reading of
 *      "authoritative" locks out both system admins);
 *   §2 sweep immunity sits ABOVE GM (user+manager sweep, area_admin+ are
 *      immune);
 *   §3 the backfill carries employee_codes (THQ's hard precondition after
 *      the three-Turners incident) and is guarded so the apply fails
 *      loudly if the derived wire field would drift from the stored flag.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/071_epd_role_authoritative.sql"),
  "utf8"
);

test("reuses the existing epd_role enum — no new type", () => {
  assert.match(sql, /add column if not exists epd_role public\.epd_role not null default 'user'/);
  assert.doesNotMatch(sql, /create type/i);
});

test("role_is_sweepable: user + manager sweep; the immunity line sits above GM", () => {
  assert.match(sql, /create or replace function public\.role_is_sweepable/);
  assert.match(sql, /select r in \('user','manager'\)/);
});

test("backfill names every ruled row by employee_code: 2 regional_admin + 8 manager", () => {
  for (const code of ["EMP-100000", "EMP-100187"]) {
    assert.ok(sql.includes(code), `regional_admin code ${code} present`);
  }
  const managerCodes = [
    "EMP-100051", "EMP-100020", "EMP-100088", "EMP-100202",
    "EMP-100100", "EMP-100007", "EMP-100148", "EMP-100159",
  ];
  for (const code of managerCodes) {
    assert.ok(sql.includes(code), `manager code ${code} present`);
  }
  assert.match(sql, /set epd_role = 'regional_admin'/);
  assert.match(sql, /set epd_role = 'manager'/);
});

test("apply fails loudly if the derived wire field would drift from the stored flag", () => {
  assert.match(sql, /\(epd_role = 'manager'\) is distinct from is_general_manager/);
  assert.match(sql, /raise exception/i);
});

test("§1 lockout guard: role derives ONLY through employee_id; an un-backed login keeps its own grant", () => {
  assert.match(
    sql,
    /select coalesce\(e\.epd_role, ur\.role\)\s*\n\s*from public\.user_roles ur\s*\n\s*left join public\.employees e on e\.id = ur\.employee_id/,
    "epd_user_role: LEFT join + coalesce — NULL employee_id falls through to user_roles.role"
  );
});

test("scope helper derives from the same coalesce — never a second role source", () => {
  assert.match(sql, /select case coalesce\(e\.epd_role, ur\.role\)/);
});

test("no mapping table exists — every shift-level role tiers as 'user' by DEFAULT, not by lookup", () => {
  assert.doesNotMatch(sql, /create table/i);
});
