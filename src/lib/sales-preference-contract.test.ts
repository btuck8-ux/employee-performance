/**
 * Contract pins for mig 060 — the Houston sales cutover as a read-time
 * preference (Houston-to-Toast spec 2026-08-25 §3). TEXT-LEVEL pins per
 * repo convention.
 *
 * Houston's 7shifts mirror dropped every tip after 2026-05-31; the fix is
 * a preference, never a destructive write. These pins hold the four
 * load-bearing properties: only superseded sevenshifts rows are filtered
 * (legacy_pos MUST keep counting — the complementary 04-30→05-04 ruling),
 * every sales reader goes through the preference view, the enablement and
 * the preference land together, and nothing is deleted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const migSrc = read("supabase/migrations/060_sales_source_preference.sql");
const orchestratorSrc = read("src/lib/ingest/toast/orchestrator.ts");

test("v_sales_effective filters ONLY superseded sevenshifts rows at Toast stores post-go-live", () => {
  assert.match(migSrc, /create or replace view public\.v_sales_effective/);
  assert.match(migSrc, /security_invoker = true/);
  assert.match(migSrc, /s\.source = 'sevenshifts'/);
  assert.match(migSrc, /cfg\.is_toast = true/);
  assert.match(migSrc, /s\.transaction_at >= cfg\.go_live::timestamp/);
  // The exclusion names exactly ONE source. legacy_pos always counts (the
  // complementary overlap ruling); toast/csv/null pass untouched.
  const exclusion = migSrc.slice(
    migSrc.indexOf("where not ("),
    migSrc.indexOf(");", migSrc.indexOf("where not ("))
  );
  const sourceLiterals = exclusion.match(/source = '\w+'/g) ?? [];
  assert.deepEqual(sourceLiterals, ["source = 'sevenshifts'"], "only sevenshifts is ever superseded");
});

test("every sales reader goes through the preference — sales_records is read directly ONLY by the view", () => {
  const directReads = migSrc.match(/(?:from|join) public\.sales_records/g) ?? [];
  assert.equal(directReads.length, 1, "exactly one direct read — v_sales_effective itself");
  for (const fn of [
    "v_sales_presence",
    "compute_employee_tip_metrics",
    "recompute_team_tip_impact",
    "compute_employee_hourly_tip_rate",
  ]) {
    assert.match(
      migSrc,
      new RegExp(`create or replace (view|function) public\\.${fn}`),
      `${fn} re-emitted onto the preference`
    );
  }
  assert.match(migSrc, /public\.v_sales_effective/);
});

test("no SOURCE row is deleted — supersede and prefer, retire only on Tucker's word", () => {
  // recompute_team_tip_impact's slice-rebuild deletes from its own DERIVED
  // table (018's idempotence pattern, carried verbatim) — that is not a
  // source deletion. sales_records rows are never touched destructively.
  assert.doesNotMatch(migSrc, /delete from public\.sales_records/i);
  assert.doesNotMatch(migSrc, /update public\.sales_records/i);
  assert.doesNotMatch(migSrc, /\bdrop table\b/i);
});

test("null-source rows PASS the preference — a finding must never be silently dropped", () => {
  // Under bare SQL null semantics `not (s.source = 'sevenshifts' and …)`
  // evaluates NULL for a null-source row and drops it. The coalesce is
  // load-bearing.
  assert.match(migSrc, /coalesce\(s\.source = 'sevenshifts', false\)/);
});

test("HOU enablement is a guarded seed and lands WITH the preference, never separately", () => {
  assert.match(
    migSrc,
    /set toast_sales_enabled = true[\s\S]*?where location_code = 'HOU'[\s\S]*?toast_sales_enabled is distinct from true/
  );
  // mig 041's rule is superseded by ruling, and the orchestrator header
  // records the revision rather than silently dropping the old absolute.
  assert.match(orchestratorSrc, /HOU RULE REVISED \(Tucker 2026-08-25/);
  assert.match(orchestratorSrc, /superseded at read, never deleted|superseded at read,\s*\n?\s*\* never deleted/);
});

test("dependencies and apply-order are declared — 058 + 059 first, all with the flip", () => {
  assert.match(migSrc, /requires 058/i);
  assert.match(migSrc, /059/);
  assert.match(migSrc, /FILE-ONLY/);
});
