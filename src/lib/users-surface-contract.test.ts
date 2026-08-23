/**
 * Contract pins for the Users surface + Settings nav (2026-08-23 sprint
 * §4-D) — text-level pins per repo convention.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILES = {
  actions: "src/app/dashboard/admin/users/actions.ts",
  page: "src/app/dashboard/admin/users/page.tsx",
  form: "src/components/admin/UserInviteForm.tsx",
  adminIndex: "src/app/dashboard/admin/page.tsx",
  layout: "src/app/dashboard/layout.tsx",
  navLinks: "src/components/nav-links.tsx",
};

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const actionsSrc = read(FILES.actions);
const pageSrc = read(FILES.page);
const formSrc = read(FILES.form);

test("NO passwords anywhere in the Users surface (§4-D3, non-negotiable)", () => {
  // The word itself must not appear — not as a field, a variable, a comment
  // workaround, or an API call. Invitation-only is the whole model.
  for (const [name, rel] of Object.entries(FILES)) {
    assert.doesNotMatch(
      read(rel),
      /password/i,
      `${name} (${rel}) must not mention passwords in any form`
    );
  }
});

test("provisioning is invitation-only — no direct account creation", () => {
  assert.match(actionsSrc, /inviteUserByEmail/);
  assert.doesNotMatch(actionsSrc, /createUser\(/);
  assert.doesNotMatch(actionsSrc, /updateUserById/);
});

test("both actions re-check system_admin server-side", () => {
  const gates = actionsSrc.match(/role !== "system_admin"/g) ?? [];
  assert.ok(
    gates.length >= 2,
    `expected an SA gate in invite AND revoke, found ${gates.length}`
  );
  assert.match(pageSrc, /role !== "system_admin"/);
});

test("the target is resolved and role-checked BEFORE any invite email (§4-D8a)", () => {
  const resolveIdx = actionsSrc.indexOf("findAuthUserByEmail(admin, email)");
  const roleCheckIdx = actionsSrc.indexOf('.from("user_roles")\n      .select("role")');
  const inviteIdx = actionsSrc.indexOf("inviteUserByEmail(email)");
  assert.ok(resolveIdx !== -1, "pre-invite directory resolve present");
  assert.ok(inviteIdx !== -1, "invite call present");
  assert.ok(
    resolveIdx < inviteIdx,
    "directory resolve must run before the invite email"
  );
  assert.ok(
    roleCheckIdx !== -1 && roleCheckIdx < inviteIdx,
    "existing-role check must run before the invite email"
  );
});

test("existing roles are refused, never modified (§4-D7 doctrine)", () => {
  assert.match(actionsSrc, /already holds the .* role — revoke it first/);
  // No update path on user_roles exists on this surface.
  assert.doesNotMatch(actionsSrc, /from\("user_roles"\)[\s\S]{0,80}\.update\(/);
});

test("the last system_admin can never be revoked (§4-D7)", () => {
  assert.match(actionsSrc, /count: "exact"/);
  assert.match(actionsSrc, /count <= 1/);
  assert.match(actionsSrc, /Refusing to revoke the last system_admin/);
});

test("failed lookups fail CLOSED — no fall-through to a grant (§4-D8)", () => {
  assert.match(actionsSrc, /nothing sent, nothing granted/);
  assert.match(actionsSrc, /no grant made/);
  assert.match(actionsSrc, /nothing revoked/);
});

test("audit line per invite/grant/revoke with actor + target (§4-D8)", () => {
  assert.match(actionsSrc, /console\.log\("\[users\] role granted"/);
  assert.match(actionsSrc, /console\.log\("\[users\] role revoked"/);
  assert.match(actionsSrc, /actor: user\.id/);
});

test("public.users is never read or written by the surface (§4-D6)", () => {
  for (const src of [actionsSrc, pageSrc, formSrc]) {
    assert.doesNotMatch(src, /from\("users"\)/);
  }
});

test("scope ids are read from the database, never hardcoded (§4-D5)", () => {
  assert.match(pageSrc, /from\("territories"\)/);
  assert.match(pageSrc, /from\("locations"\)/);
  // No literal uuids in the actions or form.
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
  assert.doesNotMatch(actionsSrc, UUID_RE);
  assert.doesNotMatch(formSrc, UUID_RE);
});

test("departed report is read-only — no writes on the page (§4-D9)", () => {
  assert.doesNotMatch(pageSrc, /\.insert\(/);
  assert.doesNotMatch(pageSrc, /\.update\(/);
  assert.doesNotMatch(pageSrc, /\.delete\(/);
  assert.match(pageSrc, /DEPARTED_DAYS = 60/, "the 60-day default is stated");
});

test("Settings nav group reaches all three admin surfaces (§4-D1)", () => {
  const layoutSrc = read(FILES.layout);
  assert.match(layoutSrc, /href: "\/dashboard\/admin"/);
  assert.match(layoutSrc, /\/dashboard\/admin\/scoring/);
  assert.match(layoutSrc, /\/dashboard\/admin\/employee-triage/);
  assert.match(layoutSrc, /\/dashboard\/admin\/users/);
});

test("nav icons are registered by name — components never cross the boundary", () => {
  const navSrc = read(FILES.navLinks);
  assert.match(navSrc, /"use client"/);
  for (const key of ["settings", "triage", "users", "scoring"]) {
    assert.match(
      navSrc,
      new RegExp(`["']?${key}["']?:\\s*[A-Z]`),
      `icon "${key}" registered in the ICONS map`
    );
  }
});
