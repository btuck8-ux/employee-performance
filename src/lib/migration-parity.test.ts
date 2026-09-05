/**
 * Migration parity — OFFLINE mode (W2b): CI, against fixtures. This suite
 * never claims live parity; it pins the matching algorithm and the report
 * classes. Live parity is scripts/migration-parity-live.ts against the
 * production ledger.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  checkMigrationParity,
  formatParityReport,
  liveExitFor,
  LIVE_EXIT,
  UNPREFIXED_LEDGER_MAPPINGS,
  JUSTIFIED_EXCEPTIONS,
  GATE_PENDING_MIGRATIONS,
  type LedgerRow,
} from "./migration-parity.ts";

const diskStems = readdirSync(join(process.cwd(), "supabase", "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.replace(/\.sql$/, ""));

test("prefixed ledger rows match by exact filename stem", () => {
  const report = checkMigrationParity(
    ["001_init_schema", "018b_team_tip_impact_optimize"],
    [
      { version: "20260429040539", name: "001_init_schema" },
      { version: "20260515171800", name: "018b_team_tip_impact_optimize" },
    ]
  );
  assert.equal(report.counts.matchedExact, 2);
  assert.equal(report.findings.length, 0);
  // Version identity rides along but is not the matching key.
  assert.deepEqual(report.matchedExact[0], {
    stem: "001_init_schema",
    version: "20260429040539",
  });
});

test("exactly 13 unprefixed mappings are enumerated", () => {
  assert.equal(UNPREFIXED_LEDGER_MAPPINGS.length, 13);
  const names = UNPREFIXED_LEDGER_MAPPINGS.map((m) => m.ledgerName);
  assert.equal(new Set(names).size, 13, "no duplicate ledger names");
});

// Each mapping gets its own test asserting it resolves — both against a
// fixture carrying that ledger row, and against the real migrations dir
// (the mapped file must exist on disk).
for (const { ledgerName, fileStem } of UNPREFIXED_LEDGER_MAPPINGS) {
  test(`mapping resolves: ledger '${ledgerName}' → ${fileStem}.sql`, () => {
    assert.ok(
      diskStems.includes(fileStem),
      `${fileStem}.sql must exist in supabase/migrations`
    );
    const exception = JUSTIFIED_EXCEPTIONS.find(
      (e) => e.ledgerName === ledgerName
    );
    const row: LedgerRow = {
      version: exception?.version ?? "20990101000000",
      name: ledgerName,
    };
    const report = checkMigrationParity([fileStem], [row]);
    if (exception) {
      // The exception pair is accounted for in its own class, never silent.
      assert.equal(report.counts.justifiedException, 1);
      assert.equal(report.counts.fileNotApplied, 0);
    } else {
      assert.equal(report.counts.matchedViaMapping, 1);
      assert.deepEqual(report.matchedViaMapping[0], {
        ledgerName,
        stem: fileStem,
        version: row.version,
      });
      assert.equal(report.findings.length, 0);
    }
  });
}

test("an unknown ledger row is a finding (applied_no_file), never a silent pass", () => {
  const report = checkMigrationParity(
    ["001_init_schema"],
    [
      { version: "20260429040539", name: "001_init_schema" },
      { version: "20261231000000", name: "totally_unknown_row" },
    ]
  );
  assert.equal(report.counts.appliedNoFile, 1);
  assert.match(report.findings[0].detail, /matches no repo file/);
  assert.equal(liveExitFor(report), LIVE_EXIT.FINDINGS);
});

test("a repo file with no ledger row is a finding (file_not_applied)", () => {
  const report = checkMigrationParity(
    ["001_init_schema", "058_worked_intervals_flip"],
    [{ version: "20260429040539", name: "001_init_schema" }]
  );
  assert.equal(report.counts.fileNotApplied, 1);
  assert.equal(report.findings[0].fileStem, "058_worked_intervals_flip");
  // The wording must not overclaim: no ledger row ≠ DDL not live.
  assert.match(report.findings[0].detail, /no ledger row/);
});

test("two ledger rows resolving to one file is a collision (must fail)", () => {
  // 'csv_uploads_bucket' maps to 021_csv_uploads_bucket; a prefixed ledger
  // row with the same stem then collides on that single file.
  const report = checkMigrationParity(
    ["021_csv_uploads_bucket"],
    [
      { version: "20260516062259", name: "021_csv_uploads_bucket" },
      { version: "20260516062260", name: "csv_uploads_bucket" },
    ]
  );
  assert.equal(report.counts.ambiguousCollision, 1);
  assert.match(report.findings[0].detail, /one file, two ledger keys/);
  assert.equal(liveExitFor(report), LIVE_EXIT.FINDINGS);
});

test("a duplicated ledger name is a collision", () => {
  const report = checkMigrationParity(
    ["001_init_schema"],
    [
      { version: "20260429040539", name: "001_init_schema" },
      { version: "20260429040540", name: "001_init_schema" },
    ]
  );
  assert.equal(report.counts.ambiguousCollision, 1);
  assert.match(report.findings[0].detail, /appears more than once/);
});

test("the justified exception requires EXACT identity: name + version 20260826002003", () => {
  assert.equal(JUSTIFIED_EXCEPTIONS.length, 1);
  const right = checkMigrationParity(
    ["065_q2_gap_ledger_fifth_verdict"],
    [{ version: "20260826002003", name: "q2_gap_ledger_fifth_verdict" }]
  );
  assert.equal(right.counts.justifiedException, 1);
  assert.equal(liveExitFor(right), LIVE_EXIT.CLEAN, "exception alone is not a failure");

  // Same name under a DIFFERENT version is NOT the exception.
  const wrong = checkMigrationParity(
    ["065_q2_gap_ledger_fifth_verdict"],
    [{ version: "20991231000000", name: "q2_gap_ledger_fifth_verdict" }]
  );
  assert.equal(wrong.counts.justifiedException, 0);
  assert.equal(wrong.counts.ambiguousCollision, 1);
  assert.match(wrong.findings[0].detail, /NOT the recorded exception/);
});

test("the exception does NOT excuse a missing file — absent 065 is applied_no_file (Codex 2026-09-05)", () => {
  const report = checkMigrationParity(
    [], // mapped file absent
    [{ version: "20260826002003", name: "q2_gap_ledger_fifth_verdict" }]
  );
  assert.equal(report.counts.justifiedException, 0);
  assert.equal(report.counts.appliedNoFile, 1);
  assert.match(report.findings[0].detail, /not a missing file/);
  assert.equal(liveExitFor(report), LIVE_EXIT.FINDINGS);
});

// ---- gate-pending declarations (CP3 review §4) ----

test("gate-pending is a DECLARED LIST with a written reason per entry, and every entry exists on disk (application status is the ledger's to say)", () => {
  assert.ok(GATE_PENDING_MIGRATIONS.length >= 1);
  for (const g of GATE_PENDING_MIGRATIONS) {
    assert.ok(g.reason.length > 40, `${g.fileStem}: reason must be written, not a stub`);
    assert.ok(diskStems.includes(g.fileStem), `${g.fileStem}.sql must exist on disk`);
  }
  // Exactly the two current gate-pending migrations — adding one means
  // writing its reason here, not matching a pattern.
  assert.deepEqual(
    GATE_PENDING_MIGRATIONS.map((g) => g.fileStem),
    ["094_team_tip_impact_baseline_once", "095_ingest_runs_partial_status"]
  );
});

test("a declared gate-pending file reports in its OWN class — never as file_not_applied drift", () => {
  const report = checkMigrationParity(
    ["001_init_schema", "094_team_tip_impact_baseline_once", "058_worked_intervals_flip"],
    [{ version: "20260429040539", name: "001_init_schema" }]
  );
  assert.equal(report.counts.gatePending, 1);
  assert.equal(report.counts.fileNotApplied, 1, "the HISTORICAL no-ledger-row file still reports as drift");
  const gate = report.findings.find((f) => f.class === "gate_pending");
  assert.equal(gate?.fileStem, "094_team_tip_impact_baseline_once");
  assert.match(gate?.detail ?? "", /DECLARED gate-pending \(not drift\)/);
  assert.match(gate?.detail ?? "", /G4/);
});

test("declared gate-pending alone does not fail the run; real drift still does", () => {
  const declaredOnly = checkMigrationParity(
    ["001_init_schema", "095_ingest_runs_partial_status"],
    [{ version: "20260429040539", name: "001_init_schema" }]
  );
  assert.equal(liveExitFor(declaredOnly), LIVE_EXIT.CLEAN);
  const withDrift = checkMigrationParity(
    ["001_init_schema", "095_ingest_runs_partial_status", "058_worked_intervals_flip"],
    [{ version: "20260429040539", name: "001_init_schema" }]
  );
  assert.equal(liveExitFor(withDrift), LIVE_EXIT.FINDINGS);
});

test("a STALE declaration (file now in the ledger) is a hard finding, never silent", () => {
  const report = checkMigrationParity(
    ["094_team_tip_impact_baseline_once"],
    [{ version: "20991231000000", name: "094_team_tip_impact_baseline_once" }]
  );
  assert.equal(report.counts.gatePending, 0);
  const stale = report.findings.find((f) => /declaration is STALE/.test(f.detail));
  assert.ok(stale, "stale declaration must surface");
  assert.equal(stale?.class, "ambiguous_collision");
  assert.equal(liveExitFor(report), LIVE_EXIT.FINDINGS);
});

// (A declaration naming a file absent from disk is caught by the
// declared-list test above, which asserts every entry against the REAL
// migrations directory — the pure core only sees the file list it is
// handed, so that staleness direction lives here, not in fixtures.)

test("the report prints the gate-pending class", () => {
  const text = formatParityReport(
    checkMigrationParity(
      ["094_team_tip_impact_baseline_once", "095_ingest_runs_partial_status"],
      []
    )
  );
  assert.match(text, /GATE-PENDING \(DECLARED, AWAITING APPROVAL\) \(2\)/);
});

test("exit states are distinct — a credential skip can never read as a clean pass", () => {
  const states = Object.values(LIVE_EXIT);
  assert.equal(new Set(states).size, states.length);
  assert.notEqual(LIVE_EXIT.SKIPPED_NO_CREDENTIALS, LIVE_EXIT.CLEAN);
  assert.notEqual(LIVE_EXIT.CONNECTION_OR_SHAPE_ERROR, LIVE_EXIT.CLEAN);
});

test("the report prints all four classes even when empty", () => {
  const text = formatParityReport(
    checkMigrationParity(
      ["001_init_schema"],
      [{ version: "20260429040539", name: "001_init_schema" }]
    )
  );
  assert.match(text, /APPLIED, NO FILE \(0\)/);
  assert.match(text, /FILE, NO LEDGER ROW \(0\)/);
  assert.match(text, /AMBIGUOUS \/ COLLISION \(0\)/);
  assert.match(text, /JUSTIFIED EXCEPTION \(0\)/);
  assert.match(text, /sanity check, not proof of parity/);
});
