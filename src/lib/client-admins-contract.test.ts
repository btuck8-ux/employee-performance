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
  // Per-ACTION ordering (Codex 2026-08-14 finding: a file-order check alone
  // would pass if one action's admin client moved above its own gate): split
  // the source at exported-action boundaries and require, inside EACH body,
  // that the SA gate appears before any service-role client construction.
  const bodies = actions.split(/export async function /).slice(1);
  const actionBodies = bodies.filter((b) => b.includes("createAdminClient()"));
  assert.equal(actionBodies.length, 2, "both actions use the service-role client");
  for (const body of actionBodies) {
    const gate = body.indexOf('role !== "system_admin"');
    const admin = body.indexOf("createAdminClient()");
    assert.ok(
      gate !== -1 && gate < admin,
      `SA gate precedes createAdminClient in action "${body.slice(0, 40)}…"`
    );
  }
});

test("invite action refuses accounts that already hold a role (no silent downgrade)", () => {
  assert.match(actions, /already holds the \$\{existingRole\.role\} role/);
});

test("revoke only ever deletes regional_admin rows", () => {
  // Exactly one delete path exists in the file, and it is role-filtered —
  // a second unfiltered .delete() would fail this pin (Codex 2026-08-14).
  const deletes = actions.match(/\.delete\(\)/g) ?? [];
  assert.equal(deletes.length, 1, "exactly one delete path");
  assert.match(
    actions,
    /\.delete\(\)\s*\.eq\("user_id", targetUserId\)\s*\.eq\("role", "regional_admin"\)/
  );
});
