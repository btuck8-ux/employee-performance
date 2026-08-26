/**
 * Pin: mig 072 + the sweep path — the sweep is a NOTIFIER (epd_role spec
 * 2026-08-26 §6). "GOING FORWARD, the tombstone should act as a notifier."
 *
 * The two non-negotiables, verified at text level exactly as §9 asks
 * ("grep the migration for update.*employees.*active and confirm no
 * match"):
 *   1. NOTHING in the sweep path updates employees — deactivation is a
 *      human act on the §7c queue.
 *   2. The dormancy predicate is PERSON-LEVEL (fresh evidence at ANY
 *      associated store clears the person) — without it tonight's sweep
 *      would have deactivated six actively-working multi-store people.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/072_departure_notifier.sql"),
  "utf8"
);
const route = readFileSync(
  join(process.cwd(), "src/app/api/admin/departure-candidates/route.ts"),
  "utf8"
);

test("§9: no `update … employees … active` anywhere in the sweep path", () => {
  assert.doesNotMatch(
    migration,
    /update\s+(public\.)?employees\s+set[\s\S]{0,160}active/i
  );
  // The route's POST handler writes via the RPC only — no direct employee
  // update call anywhere in the file.
  assert.doesNotMatch(route, /from\("employees"\)[\s\S]{0,120}\.update\(/);
});

test("re-running is a no-op on anyone already surfaced — the partial unique index IS the point", () => {
  assert.match(
    migration,
    /create unique index if not exists departure_candidates_open_uniq\s*\n\s*on public\.departure_candidates \(employee_id\) where status = 'open'/
  );
  assert.match(migration, /on conflict do nothing/);
});

test("tier gate rides role_is_sweepable — area_admin and above are immune", () => {
  assert.match(migration, /public\.role_is_sweepable\(e\.epd_role\)/);
});

test("every evidence clause is person-level: siblings correlate on seven_shifts_user_id", () => {
  const personClauses = migration.match(
    /e\.seven_shifts_user_id is not null/g
  );
  assert.ok(
    (personClauses?.length ?? 0) >= 6,
    `person-level correlation in laterals + all four NOT EXISTS clauses (found ${personClauses?.length ?? 0})`
  );
  // All four evidence sources, each windowed to 30 days.
  const windows = migration.match(/> current_date - 30/g);
  assert.equal(windows?.length, 4, "four 30-day evidence windows");
  assert.match(migration, /entry_type = 'worked'/);
  assert.match(migration, /entry_type = 'scheduled'/);
  assert.match(migration, /toast_time_entries/);
  assert.match(migration, /seven_shifts_shifts/);
});

test("§1g: recent scheduled mirror rows are freshness-tested — a ghost never suppresses a departure", () => {
  assert.match(migration, /ir\.source = 'cp_schedule'/);
  assert.match(migration, /ir\.status = 'success'/);
  assert.match(migration, /te\.entry_date < current_date - 14\s*\n\s*or te\.updated_at >=/);
});

test("a dismissal stands until new activity — dismissed people do not reinsert every run", () => {
  assert.match(migration, /dc\.status = 'dismissed'/);
  assert.match(migration, /dc\.resolved_at >= greatest\(/);
});

test("candidate table carries the operator-review lifecycle", () => {
  assert.match(migration, /status\s+text not null default 'open'/);
  assert.match(migration, /resolved_at\s+timestamptz/);
  assert.match(migration, /resolved_by\s+uuid references public\.users\(id\)/);
});

test("sweep lever: POST behind CRON_SECRET, GET report untouched", () => {
  assert.match(route, /export async function POST\(request: Request\)/);
  assert.match(route, /rpc\("sweep_departure_candidates"\)/);
  assert.match(route, /export async function GET\(request: Request\)/);
});

test("sweep function is service-role only — never callable by browsers", () => {
  assert.match(
    migration,
    /revoke execute on function public\.sweep_departure_candidates\(\)\s*\n\s*from public, anon, authenticated/
  );
  assert.match(migration, /grant execute on function public\.sweep_departure_candidates\(\) to service_role/);
});
