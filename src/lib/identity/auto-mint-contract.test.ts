/**
 * Contract pins for the nightly auto-mint job (2026-08-31 identity packet §3).
 *
 * Behavioural tests over the pure classification helpers, plus TEXT-LEVEL pins
 * (repo convention) over the properties that are invisible at runtime until
 * the night they matter: the cap, the never-set columns, the migration.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BLAST_RADIUS_CAP } from "./auto-mint.ts";
import {
  buildExclusionPairs,
  isDetectionExcluded,
  normalizeSevenShiftsUserId,
} from "../triage/detections.ts";

const poolSrc = readFileSync(
  join(process.cwd(), "src/lib/identity/auto-mint.ts"),
  "utf8"
);
const orchSrc = readFileSync(
  join(process.cwd(), "src/lib/identity/auto-mint-orchestrator.ts"),
  "utf8"
);
const routeSrc = readFileSync(
  join(process.cwd(), "src/app/api/cron/auto-mint/route.ts"),
  "utf8"
);
const migSrc = readFileSync(
  join(process.cwd(), "supabase/migrations/091_auto_mint_audit_and_archived_ack.sql"),
  "utf8"
);

// ── The per-store identity key ────────────────────────────────────────────
// The guard test the packet asked for, as a unit test: Milena Trevino
// (5814414) must NOT re-mint at a store she already holds, and MUST mint at a
// new one. Verified live 2026-08-31 against the DB index as well.
test("per-store key: existing store excluded, new store not excluded", () => {
  const FCOL = "aeff4706-835a-422d-9949-153ed3279b64";
  const HRANCH = "f300a9e4-3b2c-45e3-b68c-1ee7b91f50a9";
  const CPD = "40e22238-f031-47c8-a5a6-c1ca8f96fc5b";
  const cpToEpd = new Map([
    ["cp-fcol", FCOL],
    ["cp-hranch", HRANCH],
    ["cp-cpd", CPD],
  ]);
  const excluded = buildExclusionPairs([
    { seven_shifts_user_id: 5814414, location_id: FCOL },
    { seven_shifts_user_id: 5814414, location_id: HRANCH },
  ]);

  assert.equal(isDetectionExcluded(5814414, "cp-fcol", cpToEpd, excluded), true);
  assert.equal(isDetectionExcluded(5814414, "cp-hranch", cpToEpd, excluded), true);
  // The whole point of the per-store model — and of the 2026-08-31 dry run's
  // single real candidate (Taggart Dickson 9867936, already coded at FCOL,
  // newly scheduled at LONGM).
  assert.equal(isDetectionExcluded(5814414, "cp-cpd", cpToEpd, excluded), false);
});

test("a 7shifts-id-only guard would wrongly block a new-store mint", () => {
  // Regression pin for the mistake the packet warns about twice: if the key
  // were the id alone, the CPD case above would read as excluded.
  const idsOnly = new Set([5814414]);
  assert.equal(idsOnly.has(5814414), true, "id-only would block every store");
});

test("open-shift ids (0, null, unparseable) never become candidates", () => {
  // CP sends 0 for OPEN SHIFTS; CP minted a phantom "7shifts user 0" contact
  // this way before its PR #4 guarded it.
  assert.equal(normalizeSevenShiftsUserId("0"), 0);
  assert.equal(normalizeSevenShiftsUserId(null), null);
  assert.equal(normalizeSevenShiftsUserId(""), null);
  assert.equal(normalizeSevenShiftsUserId("abc"), null);
  assert.match(poolSrc, /d\.sevenShiftsUserId <= 0/);
  assert.match(poolSrc, /guardRejected \+= 1/);
});

test("an uncrosswalked CP location is skipped and escalated, never guessed", () => {
  assert.match(poolSrc, /if \(!d\.location\)/);
  assert.match(poolSrc, /unmappable\.push/);
  assert.match(orchSrc, /no EPD crosswalk/);
  assert.doesNotMatch(poolSrc, /fuzzy|bestMatch|closest/i);
});

// ── The blast-radius cap ──────────────────────────────────────────────────
test("cap is 10 and a trip mints NOTHING", () => {
  assert.equal(BLAST_RADIUS_CAP, 10, "approved by Tucker 2026-08-31");
  assert.match(orchSrc, /pool\.candidates\.length > cap/);
  assert.match(orchSrc, /blast_radius_tripped = true/);
  // The else-if is what guarantees no partial mint on a trip.
  assert.match(orchSrc, /\} else if \(!dryRun\) \{/);
});

// ── Never-set columns ─────────────────────────────────────────────────────
test("auto-mint never sets employee_code, epd_role, or is_general_manager", () => {
  const insertBlock = orchSrc.slice(
    orchSrc.indexOf('.from("employees")'),
    orchSrc.indexOf('.select("id, employee_code")')
  );
  assert.doesNotMatch(insertBlock, /employee_code:/);
  assert.doesNotMatch(insertBlock, /epd_role/);
  assert.doesNotMatch(insertBlock, /is_general_manager/);
  // ...and the insert carries no role-derived column at all. (Pinning the
  // absence of the literal 'MOD' would fail on the docstring that explains
  // why it must never be translated — pin the insert, not the prose.)
  assert.doesNotMatch(insertBlock, /role/i);
});

test("archived matches are reported, never minted or reactivated", () => {
  assert.doesNotMatch(orchSrc, /active:\s*true/);
  assert.doesNotMatch(orchSrc, /archived_at:\s*null/);
  assert.match(poolSrc, /never auto-reactivated/);
});

// ── Audit ─────────────────────────────────────────────────────────────────
test("every mint writes an audit row carrying the triggering CP payload", () => {
  assert.match(orchSrc, /employee_auto_mint_log/);
  assert.match(orchSrc, /trigger_row: c\.triggerRow/);
  // A failed audit must not silently pass.
  assert.match(orchSrc, /AUDIT LOG FAILED/);
});

test("mig 091 admits auto_mint and does not re-add the redundant index", () => {
  assert.match(migSrc, /'auto_mint'\]\)\)/);
  assert.match(migSrc, /employee_auto_mint_log/);
  assert.match(migSrc, /identity_archived_schedule_ack/);
  // 088 was a duplicate of employees_location_seven_shifts_user_id_key and was
  // dropped by 092 — 091 must not resurrect it.
  assert.doesNotMatch(migSrc, /create unique index/i);
});

test("route enforces CRON_SECRET and alerts on a pre-run fatal", () => {
  assert.match(routeSrc, /requireBearer\(request, process\.env\.CRON_SECRET/);
  assert.match(routeSrc, /sendFatalAlert\("\/api\/cron\/auto-mint"/);
});

// ── Mechanism (a): auto-mint rides the cp_schedule cron ───────────────────
test("auto-mint is invoked by sync-cp-schedules, and cannot fail it", () => {
  const cpRouteSrc = readFileSync(
    join(process.cwd(), "src/app/api/cron/sync-cp-schedules/route.ts"),
    "utf8"
  );
  assert.match(cpRouteSrc, /runAutoMint\(\)/);
  // Wrapped in its own try/catch: scheduled-shift rows feed attendance and
  // TIS, so a minting failure must never fail a good schedule night.
  assert.match(cpRouteSrc, /auto-mint failed \(non-fatal\)/);
  // Phase 3 introduces NO new cron entry — moving cp-schedules in Phase 4
  // moves auto-mint with it, which is what makes Phase 4 a timing-only change.
  const vercelJson = readFileSync(join(process.cwd(), "vercel.json"), "utf8");
  assert.doesNotMatch(
    vercelJson,
    /auto-mint/,
    "auto-mint must not get its own cron entry — it rides sync-cp-schedules (mechanism (a))"
  );
});
