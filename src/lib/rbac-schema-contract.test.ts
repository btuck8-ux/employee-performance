/**
 * Contract pins for migration 046 (territories + user_roles + the canonical
 * security-definer helpers) — the schema every Phase B RLS policy and every
 * app-side check (src/lib/authz.ts) builds on.
 *
 * SCOPE (deliberate): these are TEXT-LEVEL pins on the migration source —
 * they catch a helper losing `security definer`, the seed losing its
 * empty-table guard, the area_admin CHECK regressing to array_length, a
 * helper regrowing a uid parameter, or a territory dropping out of the
 * mapping. They do NOT execute SQL or exercise policies as live roles;
 * behavioral per-tier fixtures (each tier sees exactly its slice) are Phase
 * B's deliverable, and the live role-matrix test at sprint end is the
 * end-to-end proof.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/046_territories_roles.sql"),
  "utf8"
);
const code = sql.replace(/--.*$/gm, "");

test("epd_role enum carries exactly the 5 locked tiers", () => {
  const m = code.match(/create type public\.epd_role as enum\s*\(([^)]+)\)/i);
  assert.ok(m, "epd_role enum defined");
  const tiers = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.deepEqual(tiers, [
    "system_admin",
    "regional_admin",
    "area_admin",
    "manager",
    "user",
  ]);
});

test("every helper is security definer, stable, with pinned search_path", () => {
  const helpers = [
    "epd_user_role",
    "epd_is_system_admin",
    "epd_authorized_location_ids",
    "epd_can_read_employee",
  ];
  for (const fn of helpers) {
    const m = code.match(
      new RegExp(
        `create or replace function public\\.${fn}\\([^)]*\\)[\\s\\S]*?\\$\\$`,
        "i"
      )
    );
    assert.ok(m, `${fn} defined`);
    const header = m![0];
    assert.match(header, /security definer/i, `${fn} is security definer`);
    assert.match(header, /\bstable\b/i, `${fn} is stable`);
    assert.match(header, /set search_path = public/i, `${fn} pins search_path`);
  }
});

test("helper execute grants: authenticated + service_role, revoked from anon", () => {
  assert.match(code, /revoke execute on function[\s\S]*?from public, anon/i);
  assert.match(code, /grant execute on function[\s\S]*?to authenticated, service_role/i);
});

test("helpers are auth.uid()-bound — no caller-supplied uid parameter", () => {
  // A uid param + grant-to-authenticated would let any session probe any
  // other user's role/scope by UUID (Codex Phase A finding).
  assert.doesNotMatch(code, /function public\.epd_[a-z_]*\([^)]*uid uuid/i);
  assert.match(code, /function public\.epd_user_role\(\)/i);
  assert.match(code, /function public\.epd_can_read_employee\(emp_id uuid, loc_id uuid\)/i);
});

test("location_ids element-integrity trigger present (arrays can't be FK'd)", () => {
  assert.match(code, /create or replace function public\.user_roles_validate_location_ids/i);
  assert.match(code, /may not contain null elements/);
  assert.match(code, /may not contain duplicates/);
  assert.match(code, /unknown location id/);
  assert.match(
    code,
    /create trigger user_roles_location_ids_check\s+before insert or update on public\.user_roles/i
  );
});

test("area_admin scope CHECK uses cardinality, never array_length", () => {
  assert.match(code, /cardinality\(location_ids\) >= 1/);
  assert.doesNotMatch(code, /array_length/i);
});

test("scope CHECK forbids off-tier scope columns for every tier", () => {
  const check = code.match(/constraint user_roles_scope_shape check \(([\s\S]*?)\)\s*\)/i);
  assert.ok(check, "scope-shape CHECK present");
  for (const tier of ["system_admin", "regional_admin", "area_admin", "manager", "user"]) {
    assert.match(check![1], new RegExp(`when '${tier}'`), `${tier} covered`);
  }
});

test("system_admin seed is guarded against re-application", () => {
  assert.match(
    code,
    /insert into public\.user_roles \(user_id, role\)[\s\S]*?where not exists \(select 1 from public\.user_roles\)/i
  );
});

test("territory mapping covers all 8 location codes and fails loud on strays", () => {
  for (const c of ["CPD", "COS", "DTD", "FCOL", "HRANCH", "LONGM"]) {
    assert.match(code, new RegExp(`'${c}'`), `${c} mapped`);
  }
  assert.match(code, /when l\.location_code = 'NOLA' then 'nola'/);
  assert.match(code, /when l\.location_code = 'HOU'\s+then 'houston'/);
  assert.match(code, /raise exception 'locations exist with no territory mapping/);
});

test("RLS enabled on territories and user_roles; writes are SA-gated", () => {
  assert.match(code, /alter table public\.territories enable row level security/i);
  assert.match(code, /alter table public\.user_roles enable row level security/i);
  const write = code.match(/create policy user_roles_sa_write[\s\S]*?with check \(([^)]*\))/i);
  assert.ok(write, "SA write policy present");
  assert.match(write![0], /epd_is_system_admin\(\)/);
});
