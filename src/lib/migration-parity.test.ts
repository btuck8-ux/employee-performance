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
