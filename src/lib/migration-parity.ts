/**
 * Migration parity — repo files vs the production migration ledger
 * (supabase_migrations.schema_migrations). MASTER sprint W2b.
 *
 * Matching algorithm (packet rev 3 — rev 2's strip-the-prefix rule is
 * replaced; it broke the 77 ledger rows that DO carry a numeric prefix):
 *   1. Exact match first — filename stem against ledger `name`.
 *   2. Then the explicit ledger_name → filename mappings below (the
 *      unprefixed ledger names), each pinned by its own test.
 *   3. Anything still unmatched is a FINDING, never a silent pass.
 *
 * Filename↔ledger-name matching is deliberately distinct from
 * migration-version identity (the ledger's timestamp key, e.g.
 * 20260510042219 for 015): they are different keys and the report carries
 * both without conflating them. Counts are a sanity check only — matching
 * says nothing about function-body equivalence.
 *
 * Two modes, both required, share this core:
 *   - LIVE (scripts/migration-parity-live.ts): production ledger over an
 *     explicitly read-only connection; skips LOUDLY on missing credentials.
 *   - OFFLINE (migration-parity.test.ts): CI, against fixtures. Never
 *     claims live parity.
 */

export type LedgerRow = { version: string; name: string };

export type ParityClass =
  | "applied_no_file" // ledger row with no matching repo file
  | "file_not_applied" // repo file with no ledger row (NOTE: "no ledger row" — whether its DDL is live in the schema is a different question this check cannot answer)
  | "ambiguous_collision" // two files resolving to one ledger row, duplicate ledger names, or an inconsistent declaration
  | "justified_exception" // enumerated below, with exact identity — reported, never silent
  | "gate_pending"; // DECLARED written-and-unapplied migrations awaiting their approval gate — distinct from historical drift

export type ParityFinding = {
  class: ParityClass;
  ledgerName?: string;
  ledgerVersion?: string;
  fileStem?: string;
  detail: string;
};

export type ParityReport = {
  matchedExact: Array<{ stem: string; version: string }>;
  matchedViaMapping: Array<{ ledgerName: string; stem: string; version: string }>;
  findings: ParityFinding[];
  counts: {
    files: number;
    ledgerRows: number;
    matchedExact: number;
    matchedViaMapping: number;
    appliedNoFile: number;
    fileNotApplied: number;
    ambiguousCollision: number;
    justifiedException: number;
    gatePending: number;
  };
};

/**
 * The 13 unprefixed ledger names and the repo filename stem each maps to.
 * Enumerated in full per the packet; each entry has its own test asserting
 * the mapping resolves against the on-disk migrations directory.
 */
export const UNPREFIXED_LEDGER_MAPPINGS: ReadonlyArray<{
  ledgerName: string;
  fileStem: string;
}> = [
  { ledgerName: "csv_uploads_bucket", fileStem: "021_csv_uploads_bucket" },
  { ledgerName: "location_cs_score", fileStem: "026_location_cs_score" },
  { ledgerName: "locations_location_code", fileStem: "027_locations_location_code" },
  { ledgerName: "v_employee_scores", fileStem: "028_v_employee_scores" },
  { ledgerName: "v_employee_scores_latest", fileStem: "029_v_employee_scores_latest" },
  { ledgerName: "toast_kitchen_feed", fileStem: "041_toast_kitchen_feed" },
  { ledgerName: "detection_dismissals", fileStem: "052_detection_dismissals" },
  { ledgerName: "q2_gap_ledger_fifth_verdict", fileStem: "065_q2_gap_ledger_fifth_verdict" },
  { ledgerName: "metrics_start_date_floor", fileStem: "066_metrics_start_date_floor" },
  { ledgerName: "location_tip_baseline_excludes_gms", fileStem: "067_location_tip_baseline_excludes_gms" },
  { ledgerName: "identity_feed_flags", fileStem: "068_identity_feed_flags" },
  { ledgerName: "scores_feed_effective_window", fileStem: "069_scores_feed_effective_window" },
  { ledgerName: "effective_window_frozen_derivation", fileStem: "070_effective_window_frozen_derivation" },
];

/**
 * The one justified exception, with exact identity (name AND version — a
 * matching name under a different version is NOT the exception and lands as
 * a finding). Rationale: the applied row is a branch iteration of the
 * fifth-verdict work (612 bytes applied vs 1,693 in the merged 065 file);
 * its target table q2_gap_ledger was dropped by 081_drop_q2_gap_ledger, so
 * the work is superseded, not missing. Reported in its own class every run
 * — never silently passed.
 */
export const JUSTIFIED_EXCEPTIONS: ReadonlyArray<{
  ledgerName: string;
  version: string;
  rationale: string;
}> = [
  {
    ledgerName: "q2_gap_ledger_fifth_verdict",
    version: "20260826002003",
    rationale:
      "target table q2_gap_ledger dropped by 081_drop_q2_gap_ledger; applied body is a superseded branch iteration of 065",
  },
];

/**
 * Migrations that exist in the repo DELIBERATELY unapplied because their
 * application sits behind an approval gate (CP3 review §4). A DECLARED
 * list with a written reason per entry — the transfer-allowlist
 * discipline — never a pattern rule or filename-range heuristic: without
 * this, a gate-pending file reports identically to the five historical
 * file-no-ledger-row findings (058/060/061/062/063), and those are the
 * ones that cost an outage.
 *
 * Staleness is loud in both directions: a declared stem that appears in
 * the ledger (the gate was passed — remove the entry) is a hard
 * ambiguous_collision finding in every report; a declared stem with no
 * file on disk fails the OFFLINE suite (the pure core only sees the file
 * list it is handed, so the disk direction is asserted there).
 */
export const GATE_PENDING_MIGRATIONS: ReadonlyArray<{
  fileStem: string;
  reason: string;
}> = [
  {
    fileStem: "094_team_tip_impact_baseline_once",
    reason:
      "W3 FCCSU timeout fix — staged evidence complete (branch w3-fccsu-staging); application is G4, brought to Tucker with the CP1 §7 artifact package",
  },
  {
    fileStem: "095_ingest_runs_partial_status",
    reason:
      "W7 partial-status constraint widening — FIRST in the ruled deployment order; application is gate 5a (Tucker), before deploy of the inert producers and separate from activation (5b)",
  },
];

export function checkMigrationParity(
  fileStems: string[],
  ledger: LedgerRow[]
): ParityReport {
  const findings: ParityFinding[] = [];
  const matchedExact: ParityReport["matchedExact"] = [];
  const matchedViaMapping: ParityReport["matchedViaMapping"] = [];

  const stems = new Set(fileStems);
  const claimedFiles = new Map<string, string>(); // stem -> ledger name that claimed it
  const seenLedgerNames = new Map<string, string>(); // name -> version

  const mappingByLedgerName = new Map(
    UNPREFIXED_LEDGER_MAPPINGS.map((m) => [m.ledgerName, m.fileStem])
  );
  const exceptionByName = new Map(
    JUSTIFIED_EXCEPTIONS.map((e) => [e.ledgerName, e])
  );

  const claim = (stem: string, row: LedgerRow): boolean => {
    const prior = claimedFiles.get(stem);
    if (prior !== undefined) {
      findings.push({
        class: "ambiguous_collision",
        ledgerName: row.name,
        ledgerVersion: row.version,
        fileStem: stem,
        detail: `file ${stem}.sql resolves from both ledger '${prior}' and ledger '${row.name}' — one file, two ledger keys`,
      });
      return false;
    }
    claimedFiles.set(stem, row.name);
    return true;
  };

  for (const row of ledger) {
    const dupVersion = seenLedgerNames.get(row.name);
    if (dupVersion !== undefined) {
      findings.push({
        class: "ambiguous_collision",
        ledgerName: row.name,
        ledgerVersion: row.version,
        detail: `ledger name '${row.name}' appears more than once (versions ${dupVersion} and ${row.version})`,
      });
      continue;
    }
    seenLedgerNames.set(row.name, row.version);

    // The justified exception is checked on EXACT identity (name + version).
    const exception = exceptionByName.get(row.name);
    if (exception) {
      if (exception.version === row.version) {
        // The exception documents BODY divergence on an existing pair — it
        // does not excuse a missing file. If the mapped file is absent,
        // that is applied_no_file like any other row (Codex blocker-pass,
        // 2026-09-05).
        const stem = mappingByLedgerName.get(row.name);
        if (stem === undefined || !stems.has(stem)) {
          findings.push({
            class: "applied_no_file",
            ledgerName: row.name,
            ledgerVersion: row.version,
            detail: `exception row '${row.name}' has no mapped file on disk (expected ${stem ?? "<no mapping>"}.sql) — the exception covers body divergence, not a missing file`,
          });
          continue;
        }
        findings.push({
          class: "justified_exception",
          ledgerName: row.name,
          ledgerVersion: row.version,
          fileStem: stem,
          detail: exception.rationale,
        });
        // Claim its mapped file so the file does not double-land in
        // file_not_applied — the pair is fully accounted for by this class.
        claim(stem, row);
        continue;
      }
      findings.push({
        class: "ambiguous_collision",
        ledgerName: row.name,
        ledgerVersion: row.version,
        detail: `ledger name matches enumerated exception '${row.name}' but version ${row.version} != ${exception.version} — NOT the recorded exception; investigate`,
      });
      continue;
    }

    // 1. Exact match first — resolves the prefixed rows.
    if (stems.has(row.name)) {
      if (claim(row.name, row)) {
        matchedExact.push({ stem: row.name, version: row.version });
      }
      continue;
    }

    // 2. Explicit mapping for the unprefixed rows.
    const mapped = mappingByLedgerName.get(row.name);
    if (mapped !== undefined) {
      if (stems.has(mapped)) {
        if (claim(mapped, row)) {
          matchedViaMapping.push({
            ledgerName: row.name,
            stem: mapped,
            version: row.version,
          });
        }
      } else {
        findings.push({
          class: "applied_no_file",
          ledgerName: row.name,
          ledgerVersion: row.version,
          detail: `ledger '${row.name}' maps to ${mapped}.sql but that file is absent`,
        });
      }
      continue;
    }

    // 3. Unmatched ledger row is a finding, never a silent pass.
    findings.push({
      class: "applied_no_file",
      ledgerName: row.name,
      ledgerVersion: row.version,
      detail: `ledger row '${row.name}' (version ${row.version}) matches no repo file by stem or mapping`,
    });
  }

  const gatePendingByStem = new Map(
    GATE_PENDING_MIGRATIONS.map((g) => [g.fileStem, g])
  );
  // Declaration staleness: a declared stem that now has a ledger row means
  // the gate was PASSED — the declaration must be removed, loudly. (The
  // other direction — a declaration naming a file absent from disk — is
  // asserted by the offline suite against the real migrations directory,
  // since this core only sees whatever file list it is handed.)
  for (const g of GATE_PENDING_MIGRATIONS) {
    if (seenLedgerNames.has(g.fileStem)) {
      findings.push({
        class: "ambiguous_collision",
        fileStem: g.fileStem,
        ledgerName: g.fileStem,
        ledgerVersion: seenLedgerNames.get(g.fileStem),
        detail: `gate-pending declaration is STALE: ${g.fileStem}.sql now has a ledger row — the gate was passed; remove its GATE_PENDING_MIGRATIONS entry`,
      });
    }
  }

  for (const stem of fileStems) {
    if (claimedFiles.has(stem)) continue;
    const gate = gatePendingByStem.get(stem);
    if (gate && !seenLedgerNames.has(stem)) {
      // Deliberately written-and-unapplied, awaiting its approval gate —
      // its OWN class so it can never read as historical drift.
      findings.push({
        class: "gate_pending",
        fileStem: stem,
        detail: `DECLARED gate-pending (not drift): ${gate.reason}`,
      });
      continue;
    }
    findings.push({
      class: "file_not_applied",
      fileStem: stem,
      detail: `repo file ${stem}.sql has no ledger row — the ledger does not record it as applied (whether its DDL is live in the schema is a separate question this check cannot answer)`,
    });
  }

  const byClass = (c: ParityClass) =>
    findings.filter((f) => f.class === c).length;

  return {
    matchedExact,
    matchedViaMapping,
    findings,
    counts: {
      files: fileStems.length,
      ledgerRows: ledger.length,
      matchedExact: matchedExact.length,
      matchedViaMapping: matchedViaMapping.length,
      appliedNoFile: byClass("applied_no_file"),
      fileNotApplied: byClass("file_not_applied"),
      ambiguousCollision: byClass("ambiguous_collision"),
      justifiedException: byClass("justified_exception"),
      gatePending: byClass("gate_pending"),
    },
  };
}

/**
 * Exit states for the live runner. Distinct on purpose: a missing
 * credential must never look like a clean pass.
 */
export const LIVE_EXIT = {
  CLEAN: 0, // ran against the ledger; no findings beyond justified exceptions
  FINDINGS: 1, // ran; at least one non-exception finding
  SKIPPED_NO_CREDENTIALS: 2, // loud skip — could not reach the ledger for lack of credentials
  CONNECTION_OR_SHAPE_ERROR: 3, // reached out but could not get a usable ledger
} as const;

export function liveExitFor(report: ParityReport): number {
  // justified_exception and DECLARED gate_pending are explained states,
  // not drift — they do not fail the run. A stale or inconsistent
  // declaration lands in ambiguous_collision and fails like any finding.
  const nonException = report.findings.filter(
    (f) => f.class !== "justified_exception" && f.class !== "gate_pending"
  );
  return nonException.length > 0 ? LIVE_EXIT.FINDINGS : LIVE_EXIT.CLEAN;
}

export function formatParityReport(report: ParityReport): string {
  const lines: string[] = [];
  const c = report.counts;
  lines.push(
    `migration parity: ${c.files} files, ${c.ledgerRows} ledger rows — ` +
      `${c.matchedExact} exact, ${c.matchedViaMapping} via mapping ` +
      `(counts are a sanity check, not proof of parity or body equivalence)`
  );
  const classes: Array<[ParityClass, string]> = [
    ["applied_no_file", "APPLIED, NO FILE"],
    ["file_not_applied", "FILE, NO LEDGER ROW"],
    ["ambiguous_collision", "AMBIGUOUS / COLLISION"],
    ["justified_exception", "JUSTIFIED EXCEPTION"],
    ["gate_pending", "GATE-PENDING (DECLARED, AWAITING APPROVAL)"],
  ];
  for (const [cls, label] of classes) {
    const rows = report.findings.filter((f) => f.class === cls);
    lines.push(`\n${label} (${rows.length}):`);
    if (rows.length === 0) lines.push("  none");
    for (const f of rows) {
      const id = [
        f.ledgerName ? `ledger=${f.ledgerName}` : null,
        f.ledgerVersion ? `version=${f.ledgerVersion}` : null,
        f.fileStem ? `file=${f.fileStem}.sql` : null,
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(`  - ${id}\n    ${f.detail}`);
    }
  }
  return lines.join("\n");
}
