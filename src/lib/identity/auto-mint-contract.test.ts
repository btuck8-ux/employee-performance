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

// ── ONE CODE PER HUMAN (Tucker's ruling, 2026-08-31) ─────────────────────
// This ruling OVERTURNED the per-store identity model. The triage pool still
// excludes per-store pairs (that is the DB's shape until the code-retirement
// migration lands), so auto-mint applies the one-code rule as its OWN guard on
// top of the pool — pinned here.
test("triage pool still resolves per-store — auto-mint layers the rule on top", () => {
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
  // Milena still SURFACES as a pending detection at a new store — the pool has
  // not changed. Auto-mint is what refuses to mint her a third code.
  assert.equal(isDetectionExcluded(5814414, "cp-cpd", cpToEpd, excluded), false);
});

test("THE RULING: an id held at ANOTHER store is never minted", () => {
  // mintedElsewhere is the pool's own "already coded at another site" list.
  // A non-empty list must divert to the cross-store hold, never to a mint.
  assert.match(poolSrc, /if \(d\.mintedElsewhere\.length > 0\)/);
  assert.match(poolSrc, /crossStore\.push/);
  // The hold must sit BEFORE the mint push, or a held row could still be minted.
  assert.ok(
    poolSrc.indexOf("crossStore.push") < poolSrc.indexOf("candidates.push"),
    "the cross-store hold must short-circuit before the candidate push"
  );
  // And it must carry WHY it was held.
  assert.match(poolSrc, /existingCodes:/);
});

test("a genuinely new human — no code at ANY store — is still minted", () => {
  // The whole remaining value of the job. mintedElsewhere empty is the only
  // path to candidates.push; nothing else gates it.
  const guardBlock = poolSrc.slice(
    poolSrc.indexOf("if (d.mintedElsewhere.length > 0)"),
    poolSrc.indexOf("candidates.push")
  );
  assert.match(guardBlock, /continue;/);
  assert.doesNotMatch(guardBlock, /candidates\.push/);
});

test("the CP schedule read is PAGED — a 1,000-row cap would hide archived matches", () => {
  // PostgREST truncates a select() at 1,000 rows silently. The 28-day window
  // holds ~2,100 rows, so an unpaged read drops half and under-reports.
  const block = poolSrc.slice(poolSrc.indexOf("loadArchivedScheduledPairs"));
  assert.match(block, /\.range\(from, from \+ PAGE - 1\)/);
  assert.match(block, /if \(page\.length < PAGE\) break;/);
  // Paging without a total order can repeat or skip rows.
  assert.match(block, /\.order\("id", \{ ascending: true \}\)/);
});

test("the MANUAL triage page enforces the same one-code rule", () => {
  // If only the automated path enforced the ruling, the human surface would
  // keep manufacturing the redundant codes the retirement migration must undo.
  const actionsSrc = readFileSync(
    join(process.cwd(), "src/app/dashboard/admin/employee-triage/actions.ts"),
    "utf8"
  );
  assert.match(actionsSrc, /\.neq\("location_id", locationId\)/);
  assert.match(actionsSrc, /already holds \$\{held\} at another store/);
  // A hard refusal, not a confirm-through — the refusal must precede the insert.
  assert.ok(
    actionsSrc.indexOf("already holds") < actionsSrc.indexOf("const insertRow"),
    "the cross-store refusal must come before the insert is built"
  );
  // The same-store idempotency guard stays.
  assert.match(actionsSrc, /\.eq\("location_id", locationId\)/);
});

test("cross-store holds are reported out, not swallowed", () => {
  assert.match(orchSrc, /result\.cross_store_held = pool\.crossStore/);
  assert.match(orchSrc, /pool\.crossStore\.length/);
  assert.match(routeSrc, /cross_store_held/);
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
