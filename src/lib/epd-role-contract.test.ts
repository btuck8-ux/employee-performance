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
import { readFileSync, readdirSync } from "node:fs";
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

// ── mig 075: GM is a PER-STORE fact (Tucker's reversal, CSU memo §3) ───────

const sql075 = readFileSync(
  join(process.cwd(), "supabase/migrations/075_gm_per_store.sql"),
  "utf8"
);

test("075: the per-store correction — Garrison GM at FCCSU only, Mallory at FCOL only", () => {
  // A person's rows can carry different tiers at different stores. Do not
  // assume one tier per human — 071's person-level framing for these rows
  // was reversed hours after it applied.
  assert.match(sql075, /set epd_role = 'user', is_general_manager = false[\s\S]{0,120}'EMP-100100'/);
  assert.match(sql075, /set epd_role = 'manager', is_general_manager = true[\s\S]{0,120}'EMP-100225'/);
  assert.match(sql075, /set epd_role = 'user', is_general_manager = false[\s\S]{0,120}'EMP-100226'/);
});

test("075: the wire-8 gate — exactly 8 managers, at most one per store, lockstep estate-wide", () => {
  assert.match(sql075, /expected exactly 8/);
  assert.match(sql075, /having count\(\*\) > 1/);
  assert.match(sql075, /\(epd_role = 'manager'\) is distinct from is_general_manager/);
});

// ── migs 076/077: the SIXTH tier value (CSU memo §6, ruled) ────────────────

const sql076 = readFileSync(
  join(process.cwd(), "supabase/migrations/076_epd_role_unclassified_value.sql"),
  "utf8"
);
const sql077 = readFileSync(
  join(process.cwd(), "supabase/migrations/077_unclassified_default_and_sweep.sql"),
  "utf8"
);

test("076: unclassified is an EXPLICIT enum value, never a null", () => {
  assert.match(sql076, /alter type public\.epd_role add value if not exists 'unclassified'/);
});

test("077: new employees default to unclassified — no import silently asserts a tier", () => {
  assert.match(sql077, /alter column epd_role set default 'unclassified'/);
});

test("077: unclassified is NOT sweep-exempt — the unlooked-at population must stay visible to the notifier", () => {
  // CP's rule, adopted and pinned: omit unclassified from role_is_sweepable
  // and the one population nobody has looked at becomes the one population
  // the departure notifier cannot see — exactly backwards.
  assert.match(sql077, /select r in \('user','manager','unclassified'\)/);
});

// ── mig 078: the sweep gate is an ORDERING — table-driven, coverage-asserted ─

test("078: sweepability is table-driven over the LIVE enum — a seventh value fails the build until a human places it", () => {
  // Derive the enum's declaration order from the migrations themselves
  // (046 creates it; later migrations may append). A string-match on the
  // function body would pass forever regardless of what the enum does —
  // this test re-derives the verdict per value from the ordinal rule and
  // compares against the RULED table, and asserts every enum value has a
  // case so a new value cannot slip past by not having one.
  const migrationsDir = join(process.cwd(), "supabase/migrations");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  let enumOrder: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(migrationsDir, f), "utf8");
    const created = src.match(
      /create type public\.epd_role as enum\s*\n?\s*\(([^)]+)\)/
    );
    if (created) {
      enumOrder = [...created[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
    }
    for (const add of src.matchAll(
      /alter type public\.epd_role add value(?: if not exists)? '(\w+)'( before | after )?/g
    )) {
      assert.equal(
        add[2],
        undefined,
        `${f} adds an epd_role value with BEFORE/AFTER — teach this parser the position before merging`
      );
      if (!enumOrder.includes(add[1])) enumOrder.push(add[1]);
    }
  }
  assert.ok(enumOrder.length >= 6, "enum order derived from migrations");

  // The RULED table (Tucker 2026-08-26): everything above manager immune.
  const EXPECTED_SWEEPABLE: Record<string, boolean> = {
    system_admin: false,
    regional_admin: false,
    area_admin: false,
    manager: true,
    user: true,
    unclassified: true,
  };
  assert.deepEqual(
    [...enumOrder].sort(),
    Object.keys(EXPECTED_SWEEPABLE).sort(),
    "every epd_role value must carry an explicit sweepability case — a new enum value lands HERE first"
  );

  // The ordinal rule (078): r >= 'manager' in declaration order.
  const managerIdx = enumOrder.indexOf("manager");
  for (const value of enumOrder) {
    assert.equal(
      enumOrder.indexOf(value) >= managerIdx,
      EXPECTED_SWEEPABLE[value],
      `${value}: ordinal verdict must match the ruled table — if adding a value, its INSERT POSITION in the enum is the decision`
    );
  }

  // And the live definition IS the ordinal form, not a list.
  const sql078 = readFileSync(
    join(migrationsDir, "078_sweepable_ordinal.sql"),
    "utf8"
  );
  assert.match(sql078, /select r >= 'manager'::public\.epd_role/);
});

test("078: every deactivation path calls the gate — a rule enforced by a function is only enforced where the function is called", () => {
  // The regional-admin incident: the function was right and the caller was
  // somewhere else. Each app-side deactivation path must consult the SQL
  // source of truth via RPC, never a TS re-list.
  for (const p of [
    "src/app/dashboard/employees/employee-status-actions.ts",
    "src/app/dashboard/admin/departure-candidates/actions.ts",
    "src/app/dashboard/admin/toast-crosswalk/actions.ts",
  ]) {
    assert.match(
      readFileSync(join(process.cwd(), p), "utf8"),
      /rpc\(\s*"role_is_sweepable"/,
      `${p} must gate deactivation on role_is_sweepable`
    );
  }
});

test("077: unclassified is a roster state, never a grantable login role", () => {
  // The mig-046 scope-shape CHECK has no CASE branch for it (vacuous pass);
  // the explicit constraint closes that hole.
  assert.match(sql077, /check \(role <> 'unclassified'\)/);
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
