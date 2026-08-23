/**
 * Contract pins for the triage mint/dismiss surface (kickoff §3f) —
 * TEXT-LEVEL pins per repo convention, over the server actions, the page,
 * and migration 052.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const actionsSrc = readFileSync(
  join(process.cwd(), "src/app/dashboard/admin/employee-triage/actions.ts"),
  "utf8"
);
const pageSrc = readFileSync(
  join(process.cwd(), "src/app/dashboard/admin/employee-triage/page.tsx"),
  "utf8"
);

test("both server actions re-check system_admin", () => {
  const gates = actionsSrc.match(/role !== "system_admin"/g) ?? [];
  assert.ok(
    gates.length >= 2,
    `expected an SA gate in confirm AND dismiss, found ${gates.length}`
  );
});

test("the mint idempotency guard is keyed on the (7s id, location) pair", () => {
  // Pair-keyed pre-check BEFORE the insert (§4-A2, 2026-08-23 sprint): a row
  // at ANOTHER store must not read as already-minted — second-site mints are
  // legitimate (six live two-site people).
  const idGuard = '.eq("seven_shifts_user_id", ssid)';
  const guardIdx = actionsSrc.indexOf(idGuard);
  const insertIdx = actionsSrc.indexOf(".insert(insertRow)");
  assert.ok(guardIdx !== -1, "pre-check on the 7s id present");
  assert.ok(insertIdx !== -1, "insert present");
  assert.ok(guardIdx < insertIdx, "guard runs before the insert");
  // …and the mig-030 partial-index race lands on the calm already-minted
  // path, not an error — with the SAME pair key on the re-read (§4-A2's
  // second call site: a location-less re-read reports a different store's
  // code). The segments loop below proves both call sites carry the pair.
  assert.match(actionsSrc, /23505/, "unique-violation race handled");
  assert.ok(
    actionsSrc.indexOf(idGuard, insertIdx) !== -1,
    "the 23505 race re-read guards on the id too"
  );
  // No location-blind id-only guard may remain anywhere in the actions:
  // every .eq on the 7s id must be immediately followed by the location key.
  const segments = actionsSrc.split('.eq("seven_shifts_user_id", ssid)');
  for (let i = 1; i < segments.length; i++) {
    assert.ok(
      segments[i].trimStart().startsWith('.eq("location_id", locationId)'),
      `employees guard #${i} on the 7s id must also key on location_id`
    );
  }
});

test("employee_code is never set explicitly — the sequence default owns it", () => {
  // The insert payload literal must not carry employee_code (reads of the
  // minted code — the select, the audit log — are fine).
  const insertBlock = actionsSrc.match(/const insertRow[\s\S]*?\n\s*\};/);
  assert.ok(insertBlock, "insertRow payload literal present");
  assert.doesNotMatch(
    insertBlock![0],
    /employee_code/,
    "insert payload must not set employee_code"
  );
  assert.doesNotMatch(
    pageSrc,
    /employee_code\s*:/,
    "page must not write employee_code"
  );
});

test("hire_date stays null at mint — the §6-B nightly backfill owns it", () => {
  assert.doesNotMatch(actionsSrc, /hire_date\s*:/);
});

test("writes ride the authenticated client so RLS enforces SA-only", () => {
  assert.doesNotMatch(actionsSrc, /createAdminClient/);
  assert.doesNotMatch(actionsSrc, /@\/lib\/supabase\/admin/);
});

test("the page reads CP through the bridge client and gates on SA", () => {
  assert.match(pageSrc, /createCpClient\(\)/);
  assert.match(pageSrc, /role !== "system_admin"/);
  assert.doesNotMatch(pageSrc, /createAdminClient/);
});

test("mint re-derives the site server-side — location is never client input", () => {
  // Codex finding 2 (2026-08-21): a stale or tampered hidden field must not
  // pick the store.
  assert.match(actionsSrc, /resolveDetectionLocation\(/);
  assert.doesNotMatch(actionsSrc, /formData\.get\("location_id"\)/);
  const cardSrc = readFileSync(
    join(process.cwd(), "src/components/triage/DetectionCard.tsx"),
    "utf8"
  );
  assert.doesNotMatch(cardSrc, /name="location_id"/);
});

test("dismiss is keyed on the (7s id, location) pair", () => {
  assert.match(actionsSrc, /\.from\("detection_dismissals"\)/);
  assert.match(actionsSrc, /onConflict: "seven_shifts_user_id,location_id"/);
  // The site is re-derived server-side, same doctrine as the mint (Codex
  // finding 2): one resolveDetectionLocation call per action.
  const resolves = actionsSrc.match(/resolveDetectionLocation\(/g) ?? [];
  assert.ok(
    resolves.length >= 2,
    `mint AND dismiss re-derive the site server-side, found ${resolves.length}`
  );
});

// ── Migration 053 pins (file-only until Cowork/Tucker applies) ──────────────

const migSrc = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/053_detection_dismissals_per_location.sql"
  ),
  "utf8"
);

test("mig 053 shape: composite pk on the pair, RLS on, SA-only policy", () => {
  assert.match(migSrc, /create table public\.detection_dismissals/);
  assert.match(migSrc, /primary key \(seven_shifts_user_id, location_id\)/);
  assert.match(
    migSrc,
    /location_id uuid not null references public\.locations\(id\)/
  );
  assert.match(migSrc, /enable row level security/);
  assert.match(migSrc, /epd_is_system_admin/);
  // The phantom class (user id 0) must be storable.
  assert.match(migSrc, /seven_shifts_user_id >= 0/);
});
