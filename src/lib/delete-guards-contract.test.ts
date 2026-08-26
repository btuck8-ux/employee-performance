/**
 * Contract pins for mig 085 — hard-delete guards on employees AND locations
 * (ruling 12 + packet 5 §7.5). TEXT-LEVEL pins per repo convention.
 *
 * The shape being pinned, because each part dodges a specific failure:
 *   - TRIGGER, not RLS: service_role bypasses RLS and is the path the app
 *     uses — an RLS policy here is a function the admin client never calls.
 *   - BEFORE DELETE FOR EACH ROW: cascaded deletes fire row triggers, so
 *     the locations→employees cascade hits the employees guard too — a
 *     store's destruction must name both tables.
 *   - Escape hatch = a session setting naming the table explicitly inside
 *     the transaction; a bare boolean would authorize every table at once.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mig = readFileSync(
  join(process.cwd(), "supabase/migrations/085_delete_guards.sql"),
  "utf8"
);

test("085: BEFORE DELETE row triggers on BOTH employees and locations", () => {
  assert.match(
    mig,
    /create trigger employees_forbid_hard_delete\s*\n\s*before delete on public\.employees\s*\n\s*for each row execute function public\.forbid_hard_delete\(\)/
  );
  assert.match(
    mig,
    /create trigger locations_forbid_hard_delete\s*\n\s*before delete on public\.locations\s*\n\s*for each row execute function public\.forbid_hard_delete\(\)/
  );
});

test("085: the escape hatch NAMES the table — CSV allow-list, never a bare boolean", () => {
  assert.match(mig, /current_setting\('epd\.allow_hard_delete', true\)/);
  assert.match(mig, /tg_table_name = any\(/);
  assert.match(mig, /string_to_array\(/);
  // The error message teaches the hatch — an operator hitting the guard
  // must learn the correct escape in the failure itself, not a runbook.
  assert.match(mig, /SET LOCAL epd\.allow_hard_delete/);
});

test("085: guard is a trigger, not an RLS policy (service_role bypasses RLS)", () => {
  const code = mig.replace(/--.*$/gm, "");
  assert.doesNotMatch(code, /create policy/i);
  assert.match(code, /returns trigger/);
});

test("085: defence in depth — delete revoked from anon and authenticated on both tables", () => {
  assert.match(mig, /revoke delete on public\.employees from anon, authenticated/);
  assert.match(mig, /revoke delete on public\.locations from anon, authenticated/);
});
