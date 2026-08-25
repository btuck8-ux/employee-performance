/**
 * Pins for the Q2 punch-recovery packet (spec REVISED 2, 2026-08-25).
 *
 *  - §3d/§5b verdict rules: the decision table, with the spec's own cases
 *    as fixtures (Chazz/Tavian/Keara blind, Leia after-departure, Taggart
 *    sighted).
 *  - §3e: late/none convicts, no_show does NOT acquit (51% of June
 *    no_shows have a punch — the flag is a claim, not a fact).
 *  - §0's trap as structural pins: punch history reads v_worked_intervals,
 *    never raw time_entries (which holds BOTH row kinds).
 *  - §6: the punch ingest keeps the truncation flag and refuses the
 *    recompute on a truncated pull.
 *  - Read-only pins on the probe (§4) and the departure report (§7b).
 *  - §7's ruling as a build fact: the ledger route never touches
 *    performance_records.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const {
  seedVerdictForGapDay,
  isConvictingStatus,
  SEED_EVIDENCE,
  TAGGART_SEVEN_SHIFTS_USER_ID,
} = await import("./gap-ledger.ts");

// ---------------------------------------------------------------------------
// §3d decision table — the spec's own subjects as fixtures.
// ---------------------------------------------------------------------------

test("after last punch ever → scheduled_after_departure (Leia Parker: gap 06-20, last punch 06-19)", () => {
  const v = seedVerdictForGapDay({
    gapDate: "2026-06-20",
    firstPunchEver: "2025-11-02",
    lastPunchEver: "2026-06-19",
  });
  assert.equal(v.verdict, "scheduled_after_departure");
  assert.equal(v.reason, "after_last_punch");
});

test("blind, never punched → still_unknown (Chazz Limon: zero punches ever)", () => {
  const v = seedVerdictForGapDay({
    gapDate: "2026-05-14",
    firstPunchEver: null,
    lastPunchEver: null,
  });
  assert.equal(v.verdict, "still_unknown");
  assert.equal(v.reason, "blind");
});

test("blind, before first punch → still_unknown (Keara Beck: gaps end 05-10, first punch 05-13)", () => {
  const v = seedVerdictForGapDay({
    gapDate: "2026-05-10",
    firstPunchEver: "2026-05-13",
    lastPunchEver: "2026-08-20",
  });
  assert.equal(v.verdict, "still_unknown");
  assert.equal(v.reason, "blind");
});

test("sighted → confirmed_absent (Taggart's shape: gap inside a live punch history)", () => {
  const v = seedVerdictForGapDay({
    gapDate: "2026-04-15",
    firstPunchEver: "2025-06-08",
    lastPunchEver: "2026-08-20",
  });
  assert.equal(v.verdict, "confirmed_absent");
  assert.equal(v.reason, "sighted");
});

test("precedence: after-departure beats sighted; blind test is strict (<) on the first punch", () => {
  // A gap after the last punch is by definition sighted — the departure
  // rule must win.
  const departed = seedVerdictForGapDay({
    gapDate: "2026-06-25",
    firstPunchEver: "2026-01-10",
    lastPunchEver: "2026-06-19",
  });
  assert.equal(departed.verdict, "scheduled_after_departure");
  // gapDate strictly before firstPunch is blind; a gap ON the first-punch
  // date cannot exist (that day has a punch), so equality falls to sighted.
  const onFirst = seedVerdictForGapDay({
    gapDate: "2026-05-13",
    firstPunchEver: "2026-05-13",
    lastPunchEver: "2026-08-20",
  });
  assert.equal(onFirst.verdict, "confirmed_absent");
});

test("§3e: late/none convicts; no_show does NOT acquit; null/junk is nothing", () => {
  assert.equal(isConvictingStatus("late"), true);
  assert.equal(isConvictingStatus("none"), true);
  // 51% of June no_shows have a punch — most held by 7shifts itself. A
  // shift-match flag, not an attendance fact.
  assert.equal(isConvictingStatus("no_show"), false);
  assert.equal(isConvictingStatus(null), false);
  assert.equal(isConvictingStatus(undefined), false);
  assert.equal(isConvictingStatus("attended"), false);
});

test("evidence strings: never bare rule names — each cites its section and its caveat", () => {
  assert.match(SEED_EVIDENCE.after_last_punch, /candidates \(§7b\)/);
  assert.match(SEED_EVIDENCE.blind, /missing data/);
  assert.match(SEED_EVIDENCE.sighted, /§7a/);
  // Taggart keys on the 7shifts id, never a name.
  assert.equal(TAGGART_SEVEN_SHIFTS_USER_ID, 9867936);
});

// ---------------------------------------------------------------------------
// Contract pins (text-level, repo convention).
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const migrationSrc = read("supabase/migrations/064_q2_gap_ledger.sql");
const ledgerRouteSrc = read("src/app/api/admin/q2-gap-ledger/route.ts");
const departureSrc = read("src/app/api/admin/departure-candidates/route.ts");
const probeSrc = read("src/app/api/admin/probe-7shifts-punches/route.ts");
const shiftsSrc = read("src/lib/ingest/sevenshifts/shifts.ts");
const shiftsRouteSrc = read("src/app/api/admin/backfill-shifts-window/route.ts");
const timeSrc = read("src/lib/ingest/sevenshifts/time.ts");

test("mig 064: exactly the four §5b verdicts, unique per (employee, gap_date), SA-only RLS", () => {
  for (const v of [
    "punch_recovered",
    "confirmed_absent",
    "scheduled_after_departure",
    "still_unknown",
  ]) {
    assert.match(migrationSrc, new RegExp(v), `verdict enum carries ${v}`);
  }
  assert.match(migrationSrc, /unique \(employee_id, gap_date\)/);
  assert.match(migrationSrc, /enable row level security/);
  assert.match(migrationSrc, /epd_is_system_admin/);
});

test("ledger route: dry-run default, insert-only re-seed, and the §0 trap held out", () => {
  assert.match(ledgerRouteSrc, /CRON_SECRET/);
  // Seeding writes only under seed=1&write=1; ignoreDuplicates keeps every
  // existing verdict (human confirmations are append-only facts).
  assert.match(ledgerRouteSrc, /ignoreDuplicates: true/);
  assert.match(ledgerRouteSrc, /searchParams\.get\("write"\) === "1"/);
  // Gap days via the scoring source layer — reconciles by construction.
  assert.match(ledgerRouteSrc, /fetchEffectiveEntries/);
  // Punch history via the era-correct union, never raw time_entries.
  assert.match(ledgerRouteSrc, /v_worked_intervals/);
  assert.doesNotMatch(ledgerRouteSrc, /from\("time_entries"\)/);
  // §7's ruling as a build fact: the ledger never touches scoring tables
  // (the header PROSE may name them; the queries must not).
  assert.doesNotMatch(ledgerRouteSrc, /from\("performance_records"\)/);
});

test("departure report (§7b): read-only, 14-day rule, never-punched excluded", () => {
  assert.match(departureSrc, /CRON_SECRET/);
  for (const writer of ["upsert(", "insert(", "update(", "delete("]) {
    assert.ok(!departureSrc.includes(writer), `departure report must not call ${writer}`);
  }
  assert.match(departureSrc, /threshold_days/);
  assert.match(departureSrc, /v_worked_intervals/);
  assert.match(departureSrc, /never_punched_excluded/);
  assert.match(departureSrc, /CANDIDATES, NOT CONCLUSIONS/);
});

test("probe (§4): read-only, all four candidate causes, no names or emails in the report", () => {
  assert.match(probeSrc, /CRON_SECRET/);
  for (const writer of ["upsert(", "insert(", "update(", "delete("]) {
    assert.ok(!probeSrc.includes(writer), `probe must not call ${writer}`);
  }
  for (const t of ["t1_location_filter", "t2_modified_since", "t3_alternative_resources", "t4_user_id_association"]) {
    assert.match(probeSrc, new RegExp(t), `probe reports ${t}`);
  }
  // Shapes and counts only: the roster lookup selects location_id alone,
  // and no name/email column is ever selected (the header's "no names, no
  // emails" phrase is prose, so the pin checks the queries).
  assert.doesNotMatch(probeSrc, /select\("[^"]*(employee_name|email)/);
  assert.match(probeSrc, /select\("location_id"\)/);
  // Taggart is resolved (§7a) and must not be a default subject.
  assert.doesNotMatch(probeSrc, /9867936/);
});

test("§3f: an explicit window overrides both the rolling window and the floor; the lever states the coupling", () => {
  assert.match(shiftsSrc, /opts\?\.window/);
  assert.match(shiftsRouteSrc, /isValidIsoDate/);
  assert.match(shiftsRouteSrc, /no defaults/);
  // Zeros stated explicitly — rows per store per month even when zero (§9).
  assert.match(shiftsRouteSrc, /rows_per_store_per_month/);
  // The denominator consequence is measured, not discovered.
  assert.match(shiftsRouteSrc, /denominator_coupling/);
  assert.match(shiftsRouteSrc, /store_days_direct_covered_before/);
});

test("§6: the punch ingest keeps the truncation flag and refuses the recompute on a truncated pull", () => {
  assert.match(timeSrc, /getAllWithMeta<TimePunch>/);
  assert.doesNotMatch(timeSrc, /import \{ getAll \}/);
  assert.match(timeSrc, /truncated_at_page_cap/);
  assert.match(timeSrc, /recompute_skipped_truncated_pull/);
  // The gate: jobs are only enqueued from a complete pull; the surrounding
  // upsert still runs (writing punches is safe — inferring from absence is
  // not).
  const gate = timeSrc.indexOf("if (!truncated) {");
  const jobsPush = timeSrc.indexOf("jobs.push({ employee_id", gate);
  assert.ok(gate > 0 && jobsPush > gate, "recompute jobs are gated on a complete pull");
  assert.match(timeSrc, /recompute REFUSED/);
});
