/**
 * Contract pins for RBAC Phase C's client-admin surface: migration 050
 * (epd_list_client_admins) + the SA-only invite/revoke server actions.
 *
 * Same doctrine as rbac-schema-contract.test.ts: TEXT-LEVEL pins on source.
 * They catch the helper losing `security definer`/its internal role gate, a
 * uid parameter regrowing (the Codex Phase A probe finding), the grant matrix
 * loosening, or an action losing its server-side SA re-check. They do not
 * execute SQL or actions; the invite round-trip on a throwaway address is the
 * live proof (kickoff §10 smoke).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/050_client_admins_helper.sql"),
  "utf8"
);
const sqlCode = sql.replace(/--.*$/gm, "");

const actions = readFileSync(
  join(
    process.cwd(),
    "src/app/dashboard/clients/invite-actions.ts"
  ),
  "utf8"
);

test("epd_list_client_admins is security definer, stable, search_path pinned", () => {
  const m = sqlCode.match(
    /create or replace function public\.epd_list_client_admins\(\)[\s\S]*?\$\$/i
  );
  assert.ok(m, "helper defined with ZERO parameters");
  const header = m![0];
  assert.match(header, /security definer/i);
  assert.match(header, /\bstable\b/i);
  assert.match(header, /set search_path = public/i);
});

test("helper is auth.uid()-bound with an internal role gate (SA or own-territory RA)", () => {
  assert.doesNotMatch(sqlCode, /epd_list_client_admins\([^)]*uid/i);
  assert.match(sqlCode, /public\.epd_is_system_admin\(\)/i, "SA branch present");
  assert.match(
    sqlCode,
    /epd_user_role\(\)\s*=\s*'regional_admin'/i,
    "RA branch present"
  );
  assert.match(
    sqlCode,
    /where r\.user_id = auth\.uid\(\)/i,
    "RA branch scoped to the caller's own territory"
  );
});

test("helper lists only regional_admin rows and derives pending from last_sign_in_at", () => {
  assert.match(sqlCode, /ur\.role\s*=\s*'regional_admin'/i);
  assert.match(sqlCode, /last_sign_in_at is null/i);
});

test("helper execute: revoked from public/anon, granted to authenticated + service_role", () => {
  assert.match(
    sqlCode,
    /revoke execute on function public\.epd_list_client_admins\(\) from public, anon/i
  );
  assert.match(
    sqlCode,
    /grant execute on function public\.epd_list_client_admins\(\)[\s\S]*?to authenticated, service_role/i
  );
});

test("invite + revoke actions re-check system_admin server-side (fail closed)", () => {
  assert.match(actions, /^"use server";/m);
  // Both exported actions must gate on the session role BEFORE any
  // service-role work — count the checks.
  const gateCount = (
    actions.match(/role !== "system_admin"/g) ?? []
  ).length;
  assert.ok(gateCount >= 2, "both actions carry the SA re-check");
  // The role check must precede the first admin-client construction in file
  // order for each action body; cheap proxy: no createAdminClient() call
  // before the first gate.
  const firstGate = actions.indexOf('role !== "system_admin"');
  const firstAdmin = actions.indexOf("createAdminClient()");
  assert.ok(firstGate !== -1 && firstAdmin > firstGate, "gate precedes service-role client");
});

test("invite action refuses accounts that already hold a role (no silent downgrade)", () => {
  assert.match(actions, /already holds the \$\{existingRole\.role\} role/);
});

test("revoke only ever deletes regional_admin rows", () => {
  assert.match(actions, /\.eq\("role", "regional_admin"\)/);
});
