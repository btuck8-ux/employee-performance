/**
 * Text-level contract pins for migration 047 (the Phase B RLS overhaul).
 *
 * SCOPE: like rbac-schema-contract.test.ts, these pin the migration SOURCE —
 * every legacy permissive policy dropped, every table's read predicate in its
 * locked class, every write SA-gated, row-independent helper calls in the
 * InitPlan `(select ...)` form. The BEHAVIORAL proof (each tier sees exactly
 * its slice, writes denied) is supabase/tests/phase_b_policy_tests.sql, run
 * against the applied schema pre-merge.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/047_rls_role_scoped_overhaul.sql"),
  "utf8"
);
const code = sql.replace(/--.*$/gm, "");

// Every legacy policy, bound to its exact table (a drop against the wrong
// table would otherwise satisfy a name-only pin).
const LEGACY_ALL_TABLES = [
  "clients",
  "customer_reviews",
  "customer_service_score_config",
  "data_uploads",
  "employees",
  "generated_reports",
  "locations",
  "metric_thresholds",
  "performance_records",
  "report_generation_logs",
  "report_periods",
  "review_attributions",
  "sales_records",
  "survey_assignments",
  "surveys",
  "task_accountability",
  "task_owners",
  "tasks",
  "tattle_attributions",
  "tattle_responses",
  "tattle_surveys",
  "team_tip_impact",
  "time_entries",
  "total_impact_score_config",
  "user_location_access",
  "users",
];
const LEGACY_READ_TABLES = [
  "cake_profile_crosswalk",
  "ingest_runs",
  "kitchen_role_config",
  "toast_item_fulfillments",
];
const DROPPED_PUBLIC: Array<[string, string]> = [
  ...LEGACY_ALL_TABLES.map((t): [string, string] => [`${t}_authenticated_all`, t]),
  ...LEGACY_READ_TABLES.map((t): [string, string] => [`${t}_authenticated_read`, t]),
];

const DROPPED_STORAGE = [
  "csv_uploads_authenticated_select",
  "csv_uploads_authenticated_insert",
  "csv_uploads_authenticated_delete",
  "reports_authenticated_select",
  "reports_authenticated_insert",
  "reports_authenticated_update",
  "reports_authenticated_delete",
  "uploads_authenticated_select",
  "uploads_authenticated_insert",
  "uploads_authenticated_update",
  "uploads_authenticated_delete",
];

/**
 * table -> the EXACT whitespace-normalized USING clause of its read policy.
 * Exact equality (not fragment matching) so an added permissive arm — e.g.
 * `... or true` — fails the pin.
 */
const EMP_DIRECT =
  "location_id = any ((select public.epd_authorized_location_ids())) or employee_id = (select public.epd_self_employee_id())";
const EMP_ARRAY = "employee_id = any ((select public.epd_readable_employee_ids()))";
const LOC_GRAIN = "location_id = any ((select public.epd_authorized_location_ids()))";
const SA_ONLY = "(select public.epd_is_system_admin())";

const READ_MATRIX: Array<[string, string]> = [
  ["performance_records", EMP_DIRECT],
  ["generated_reports", EMP_DIRECT],
  ["time_entries", EMP_DIRECT],
  ["employees", "location_id = any ((select public.epd_authorized_location_ids())) or id = (select public.epd_self_employee_id())"],
  ["tattle_attributions", EMP_ARRAY],
  ["review_attributions", EMP_ARRAY],
  ["task_accountability", EMP_ARRAY],
  ["task_owners", EMP_ARRAY],
  ["survey_assignments", EMP_ARRAY],
  ["locations", "id = any ((select public.epd_authorized_location_ids()))"],
  ["sales_records", LOC_GRAIN],
  ["customer_reviews", LOC_GRAIN],
  ["tattle_surveys", LOC_GRAIN],
  ["surveys", LOC_GRAIN],
  ["tasks", LOC_GRAIN],
  ["team_tip_impact", LOC_GRAIN],
  ["toast_item_fulfillments", LOC_GRAIN],
  ["tattle_responses", "exists ( select 1 from public.tattle_surveys ts where ts.id = tattle_survey_id and ts.location_id = any ((select public.epd_authorized_location_ids())) )"],
  ["report_periods", "true"],
  ["metric_thresholds", "true"],
  ["clients", SA_ONLY],
  ["customer_service_score_config", SA_ONLY],
  ["total_impact_score_config", SA_ONLY],
  ["ingest_runs", SA_ONLY],
  ["data_uploads", SA_ONLY],
  ["report_generation_logs", SA_ONLY],
  ["cake_profile_crosswalk", SA_ONLY],
  ["kitchen_role_config", SA_ONLY],
  ["users", SA_ONLY],
];

/** Extract the balanced-paren USING clause from a policy block, normalized. */
function usingClause(block: string): string {
  const start = block.search(/\busing\s*\(/i);
  assert.ok(start >= 0, "policy has a USING clause");
  let i = block.indexOf("(", start);
  let depth = 0;
  const open = i;
  for (; i < block.length; i++) {
    if (block[i] === "(") depth++;
    else if (block[i] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  assert.ok(depth === 0, "balanced parens in USING clause");
  return block
    .slice(open + 1, i)
    .replace(/\s+/g, " ")
    .trim();
}

test("all 30 legacy public policies and 11 storage policies are dropped", () => {
  for (const [policy, table] of DROPPED_PUBLIC) {
    assert.match(
      code,
      new RegExp(`drop policy ${policy}\\s+on public\\.${table};`),
      `${policy} dropped from public.${table}`
    );
  }
  for (const p of DROPPED_STORAGE) {
    assert.match(code, new RegExp(`drop policy ${p}\\s+on storage\\.objects`), `${p} dropped`);
  }
});

function policyBlock(name: string, table: string): string {
  const m = code.match(
    new RegExp(`create policy ${name} on ${table.replace(".", "\\.")}[\\s\\S]*?;`)
  );
  assert.ok(m, `policy ${name} on ${table} exists`);
  return m![0];
}

for (const [table, expectedUsing] of READ_MATRIX) {
  test(`${table}: read policy USING clause matches its locked class exactly`, () => {
    const readName = code.includes(`create policy ${table}_read `)
      ? `${table}_read`
      : `${table}_sa_read`;
    const block = policyBlock(readName, `public.${table}`);
    assert.match(block, /for select\s+to authenticated/, "explicit FOR SELECT to authenticated");
    assert.equal(usingClause(block), expectedUsing);
  });

  test(`${table}: write policy is FOR ALL, system_admin-only, both arms`, () => {
    const block = policyBlock(`${table}_sa_write`, `public.${table}`);
    assert.match(block, /for all\s+to authenticated/);
    const usings = block.match(/using \(\(select public\.epd_is_system_admin\(\)\)\)/g) ?? [];
    const checks = block.match(/with check \(\(select public\.epd_is_system_admin\(\)\)\)/g) ?? [];
    assert.equal(usings.length, 1, "USING arm SA-gated");
    assert.equal(checks.length, 1, "WITH CHECK arm SA-gated");
  });
}

test("row-independent helper calls always use the (select ...) InitPlan form", () => {
  // A bare helper call in a policy body would run once per row on the big
  // tables. Strip the function-definition section first (definitions ARE
  // bare calls, legitimately).
  const policySection = code.slice(code.indexOf("drop policy"));
  for (const fn of [
    "epd_is_system_admin",
    "epd_authorized_location_ids",
    "epd_self_employee_id",
    "epd_readable_employee_ids",
  ]) {
    const calls = policySection.match(new RegExp(`public\\.${fn}\\(\\)`, "g")) ?? [];
    const wrapped = policySection.match(new RegExp(`\\(select public\\.${fn}\\(\\)\\)`, "g")) ?? [];
    assert.equal(
      calls.length,
      wrapped.length,
      `every ${fn}() call in the policy section is (select ...)-wrapped`
    );
  }
});

test("new helpers follow the 046 canon (definer, stable, pinned path, grants)", () => {
  for (const fn of ["epd_self_employee_id", "epd_readable_employee_ids"]) {
    const m = code.match(
      new RegExp(`create or replace function public\\.${fn}\\(\\)[\\s\\S]*?\\$\\$`)
    );
    assert.ok(m, `${fn} defined`);
    assert.match(m![0], /security definer/i);
    assert.match(m![0], /\bstable\b/i);
    assert.match(m![0], /set search_path = public/i);
  }
  assert.match(code, /revoke execute on function public\.epd_self_employee_id\(\),\s*public\.epd_readable_employee_ids\(\) from public, anon/);
  assert.match(code, /grant execute on function public\.epd_self_employee_id\(\),\s*public\.epd_readable_employee_ids\(\)\s*to authenticated, service_role/);
});

test("epd_can_read_employee is redefined on the same primitives the policies use", () => {
  const m = code.match(
    /create or replace function public\.epd_can_read_employee\(emp_id uuid, loc_id uuid\)[\s\S]*?\$\$;/
  );
  assert.ok(m, "redefinition present");
  assert.match(m![0], /epd_authorized_location_ids\(\)/);
  assert.match(m![0], /epd_self_employee_id\(\)/);
});

test("storage: reports select ties object name to a readable generated_reports row", () => {
  const block = policyBlock("reports_scoped_select", "storage.objects");
  assert.match(block, /bucket_id = 'reports'/);
  assert.match(block, /gr\.storage_path = storage\.objects\.name/);
  assert.match(block, /public\.epd_can_read_employee\(gr\.employee_id, gr\.location_id\)/);
});

test("storage: uploads + csv-uploads are SA-only on every command; reports writes SA-only", () => {
  for (const [bucket, prefix] of [
    ["uploads", "uploads"],
    ["csv-uploads", "csv_uploads"],
  ] as const) {
    for (const cmd of ["select", "insert", "update", "delete"]) {
      const block = policyBlock(`${prefix}_sa_${cmd}`, "storage.objects");
      assert.match(block, new RegExp(`bucket_id = '${bucket}'`));
      assert.match(block, /\(select public\.epd_is_system_admin\(\)\)/);
    }
  }
  for (const cmd of ["insert", "update", "delete"]) {
    const block = policyBlock(`reports_sa_${cmd}`, "storage.objects");
    assert.match(block, /bucket_id = 'reports'/);
    assert.match(block, /\(select public\.epd_is_system_admin\(\)\)/);
  }
});

test("vestigial tables: user_location_access dropped; users kept SA-only", () => {
  assert.match(code, /drop table public\.user_location_access/);
  assert.doesNotMatch(code, /drop table public\.users\b/);
  policyBlock("users_sa_read", "public.users");
  policyBlock("users_sa_write", "public.users");
});

test("advisor nits: trigger fn EXECUTE revoked; validator search_path pinned", () => {
  assert.match(
    code,
    /revoke execute on function public\.handle_new_auth_user\(\) from public, anon, authenticated/
  );
  assert.match(
    code,
    /alter function public\.user_roles_validate_location_ids\(\) set search_path = public/
  );
});
