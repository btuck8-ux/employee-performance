/**
 * Frozen-set drift detector (MASTER sprint W4, 2026-09-05).
 *
 * The contract with Culture Pulse and Training HQ: report_periods.frozen
 * holds EXACTLY two rows — 'Q3 2025' and 'Q4 2025', one each. This
 * detector is the BACKSTOP for unintended or unnoticed drift, reporting
 * after the fact; it does not — cannot — give partners advance notice. An
 * INTENTIONAL change to the frozen set must go through the existing
 * approval/change-notice process, notifying CP and THQ BEFORE the change
 * is applied. The detector never discharges that duty.
 *
 * The authoritative check is the production database (a set comparison
 * alone can conceal duplicate labels, so the judge counts rows per label:
 * exactly two rows carrying the two expected unique labels). The CI writer
 * scan over migration sources is a secondary heuristic only.
 *
 * Placement: runs inside /api/cron/recompute-failure-sweep, but as an
 * INDEPENDENT detector — it does not depend on ingest activity, is never
 * skipped when there are no new ingest rows, has its own alert reason
 * ("frozen-drift", never merged into the sweep's summary.shouldAlert), and
 * a failure in either detector leaves the other running and reporting.
 * Unlike the failure sweep there is no high-water mark: a drifted frozen
 * set re-alerts every pass BY DESIGN — the condition persists until
 * repaired, and silence-after-first-alert is how frozen drift would rot.
 */

import type { AdminClient } from "./sevenshifts/crosswalk";
import { sendAlertEmail, type AlertResult } from "./alert-email.ts";

/** The contract: exactly these labels, exactly one row each. */
export const EXPECTED_FROZEN_LABELS = ["Q3 2025", "Q4 2025"] as const;

export type FrozenProblemKind =
  | "missing_label"
  | "duplicate_label"
  | "unexpected_label";

export interface FrozenProblem {
  kind: FrozenProblemKind;
  label: string;
  rows: number;
}

export interface FrozenVerdict {
  drift: boolean;
  /** rows observed with frozen = true, as (label → row count) */
  observed: Record<string, number>;
  totalRows: number;
  problems: FrozenProblem[];
}

/**
 * Pure judge over the frozen rows' labels. Every deviation is a distinct,
 * named problem — a missing quarter, an extra row under a known label
 * (duplicate), and a row under an unknown label are different failures and
 * are reported as such, never collapsed into a boolean.
 */
export function judgeFrozenSet(frozenLabels: string[]): FrozenVerdict {
  const observed: Record<string, number> = {};
  for (const label of frozenLabels) {
    observed[label] = (observed[label] ?? 0) + 1;
  }

  const problems: FrozenProblem[] = [];
  for (const label of EXPECTED_FROZEN_LABELS) {
    const rows = observed[label] ?? 0;
    if (rows === 0) problems.push({ kind: "missing_label", label, rows });
    else if (rows > 1) problems.push({ kind: "duplicate_label", label, rows });
  }
  for (const [label, rows] of Object.entries(observed)) {
    if (!(EXPECTED_FROZEN_LABELS as readonly string[]).includes(label)) {
      problems.push({ kind: "unexpected_label", label, rows });
    }
  }

  return {
    drift: problems.length > 0,
    observed,
    totalRows: frozenLabels.length,
    problems,
  };
}

/**
 * The failure message carries the obligation (packet W4, verbatim shape):
 * detection is not notice; an intended change owes the partners a
 * change-notice BEFORE it is applied.
 */
export function buildFrozenDriftBody(verdict: FrozenVerdict): string {
  const labels =
    Object.entries(verdict.observed)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, rows]) => `'${label}' × ${rows}`)
      .join(", ") || "none";
  const lines: string[] = [];
  lines.push(
    `report_periods.frozen holds ${verdict.totalRows} rows (${labels}); ` +
      `EPD's contract with Culture Pulse and Training HQ states exactly Q3 2025 and Q4 2025, one row each. ` +
      `If this change is intended, the change-notice to both partners must precede it.`
  );
  lines.push("");
  lines.push("Deviations:");
  for (const p of verdict.problems) {
    lines.push(`  - ${p.kind}: '${p.label}' (${p.rows} row(s))`);
  }
  lines.push("");
  lines.push(
    "Verify: select label, count(*) from report_periods where frozen group by label;"
  );
  return lines.join("\n");
}

export interface FrozenDriftResult {
  /** 'clean' | 'drift' | 'read_error' — a read failure is NEVER clean. */
  status: "clean" | "drift" | "read_error";
  verdict: FrozenVerdict | null;
  readError: string | null;
  /** Present when drift alerted; sent:false = delivery failed (visible). */
  alert: AlertResult | null;
}

/**
 * Run the authoritative production check. Injectable reader/sender so the
 * packet's failure-mode matrix (db read failure, alert delivery failure) is
 * testable; defaults wire the real client and Resend path.
 *
 * Never throws: a database read failure is itself a distinct, visible
 * outcome (status 'read_error' + its own alert attempt) — the frozen check
 * failing must not read as "no drift", and must not take the
 * recompute-failure sweep down with it.
 */
export async function runFrozenDriftCheck(
  supabase: AdminClient,
  send: typeof sendAlertEmail = sendAlertEmail
): Promise<FrozenDriftResult> {
  let labels: string[];
  try {
    const { data, error } = await supabase
      .from("report_periods")
      .select("label")
      .eq("frozen", true);
    if (error) throw new Error(error.message);
    labels = ((data ?? []) as Array<{ label: string }>).map((r) => r.label);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const alert = await send(
      "[EPD] FROZEN-DRIFT CHECK COULD NOT READ report_periods",
      `The frozen-set drift check failed to read report_periods: ${message}\n` +
        "An unreadable frozen set is NOT a clean result — the contract with CP and THQ is unverified until this is fixed.",
      "frozen-drift",
      "FATAL ALERT"
    );
    return { status: "read_error", verdict: null, readError: message, alert };
  }

  const verdict = judgeFrozenSet(labels);
  if (!verdict.drift) {
    return { status: "clean", verdict, readError: null, alert: null };
  }

  const alert = await send(
    `[EPD] FROZEN-SET DRIFT — report_periods.frozen holds ${verdict.totalRows} row(s), expected 2`,
    buildFrozenDriftBody(verdict),
    "frozen-drift"
  );
  return { status: "drift", verdict, readError: null, alert };
}

// ---------------------------------------------------------------------------
// Secondary heuristic: the CI writer scan. Ten migrations mention `frozen`;
// only 063 may WRITE it. This never replaces the production check above.
// ---------------------------------------------------------------------------

/**
 * Does this migration SQL contain a statement shape that can WRITE
 * report_periods.frozen? Covers the actual writer forms (Codex CP2
 * hardening: scoped to report_periods, multi-column SET lists caught,
 * line AND block comments stripped):
 *   update report_periods set … frozen = … (anywhere in the SET list)
 *   a column definition with a default (frozen boolean … default true)
 *   insert into report_periods (… frozen …)
 * Reads (where frozen / case when rp.frozen / comments / other tables'
 * columns) do not count. Secondary heuristic only — the production check
 * stays authoritative.
 */
export function sqlWritesFrozen(sql: string): boolean {
  const noComments = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  // update … report_periods … set <list>: frozen ASSIGNED in the SET list
  // itself — the list ends at WHERE/FROM/RETURNING/';', so a frozen in the
  // predicate is a read, not a write. Case-insensitive throughout.
  for (const m of noComments.matchAll(
    /\bupdate\s+(?:only\s+)?(?:public\s*\.\s*)?report_periods\b[\s\S]*?\bset\b([\s\S]*?)(?:\bwhere\b|\bfrom\b|\breturning\b|;|$)/gi
  )) {
    if (/\bfrozen\s*=/i.test(m[1])) return true;
  }
  // A frozen column default counts only on report_periods' own DDL —
  // another table adding a `frozen` column is not this contract's business.
  for (const m of noComments.matchAll(
    /\b(?:create\s+table|alter\s+table)\s+(?:if\s+not\s+exists\s+)?(?:only\s+)?(?:public\s*\.\s*)?report_periods\b([\s\S]*?)(?:;|$)/gi
  )) {
    if (/\bfrozen\s+boolean[^,;)]*default/i.test(m[1])) return true;
  }
  if (
    /\binsert\s+into\s+(?:public\s*\.\s*)?report_periods\s*\([^)]*\bfrozen\b[^)]*\)/i.test(noComments)
  ) {
    return true;
  }
  return false;
}
