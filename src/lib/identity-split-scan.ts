/**
 * Scan B — the identity-split detector (epd_role spec 2026-08-26 §8a).
 *
 * EPD-side by ruling (THQ's amendment accepted): THQ can enumerate candidate
 * pairs from names but cannot classify them — the punch/schedule asymmetry
 * that separates a split from two colleagues (27p/0s against 0p/22s) exists
 * only in EPD. The SQL lives in scan_identity_splits() (mig 073); this
 * module shapes its output into the weekly report: HITS ONLY, with the
 * total pair count as drift metadata against the agreed baseline of 19
 * (estate-wide, same-location pairs — verified against prod pre-apply; a
 * drift of one is the readable signal both sides agreed to watch).
 *
 * Alerting mirrors the ingest alert doctrine (alert.ts): Resend when
 * configured, loud console otherwise — visibility never depends on email
 * alone because the cron's JSON response carries the same report.
 */

/** Estate-wide same-location pair count both sides reconciled 2026-08-26. */
export const SPLIT_PAIR_BASELINE = 19;

export interface SplitScanRow {
  location_code: string;
  /** Same detector, two severities (Tucker 2026-08-26): 'crosswalk' = a
   * Toast store, where punches match by vendor GUID — a hit means the
   * CROSSWALK FAILED, a worse finding. 'name' = NOLA's name-match, the
   * known mechanism doing the expected thing. */
  punch_match: "crosswalk" | "name";
  employee_code_a: string;
  employee_name_a: string;
  employee_code_b: string;
  employee_name_b: string;
  match_basis: string;
  punches_a: number;
  scheduled_a: number;
  punches_b: number;
  scheduled_b: number;
  is_hit: boolean;
}

export interface SplitScanReport {
  scan: "identity-split";
  scope: "estate-wide, pairs never cross a location";
  pair_count: number;
  pair_baseline: number;
  pair_drift: number;
  hit_count: number;
  /** Hits at Toast stores — the crosswalk failed; worse than a NOLA hit. */
  crosswalk_hit_count: number;
  hits: SplitScanRow[];
  note: string;
}

/** Pure shaping: hits only on the wire; the pair list never leaves the DB. */
export function buildSplitReport(rows: SplitScanRow[]): SplitScanReport {
  const hits = rows.filter((r) => r.is_hit);
  return {
    scan: "identity-split",
    scope: "estate-wide, pairs never cross a location",
    pair_count: rows.length,
    pair_baseline: SPLIT_PAIR_BASELINE,
    pair_drift: rows.length - SPLIT_PAIR_BASELINE,
    hit_count: hits.length,
    crosswalk_hit_count: hits.filter((h) => h.punch_match === "crosswalk").length,
    hits,
    note:
      "Hits are PROBABLE identity splits (one side punch-only, the other schedule-only) — candidates for human review, never auto-merged. A CROSSWALK-labelled hit is the worse finding: that store matches punches by vendor GUID, so the crosswalk failed. Non-hit pairs are colleagues and are deliberately not reported.",
  };
}

/** One line per hit for the alert body — codes carried per the THQ rule
 * (a memo naming a person carries the code or it is not sendable). */
export function formatHitLines(hits: SplitScanRow[]): string[] {
  return hits.map(
    (h) =>
      `  ${h.punch_match === "crosswalk" ? "⚠ CROSSWALK FAILURE" : "name-match"} at ${h.location_code}: ` +
      `${h.employee_name_a} (${h.employee_code_a}, ${h.punches_a}p/${h.scheduled_a}s) ↔ ` +
      `${h.employee_name_b} (${h.employee_code_b}, ${h.punches_b}p/${h.scheduled_b}s) — matched on ${h.match_basis}`
  );
}

const ALERT_FROM =
  process.env.INGEST_ALERT_FROM ?? "EPD Ingest <onboarding@resend.dev>";

/**
 * Email the report when it contains hits; no-op otherwise. Same env gating
 * and console fallback as the ingest alerts. Never throws.
 */
export async function maybeSendSplitAlert(
  report: SplitScanReport
): Promise<{ sent: boolean; reason: string }> {
  if (report.hit_count === 0) return { sent: false, reason: "no hits" };

  const body = [
    `Weekly identity-split scan found ${report.hit_count} probable split(s)` +
      (report.crosswalk_hit_count > 0
        ? ` — ${report.crosswalk_hit_count} at Toast store(s), meaning the CROSSWALK FAILED there (the worse finding):`
        : ":"),
    "",
    ...formatHitLines(report.hits),
    "",
    `Pair count ${report.pair_count} vs baseline ${report.pair_baseline} (drift ${report.pair_drift >= 0 ? "+" : ""}${report.pair_drift}).`,
    "A split means one roster row holds the punches and a second row holds the schedule for the same person — resolve by hand (the Tolan/Tolson pattern); never auto-merge. A name-match hit at NOLA is the known mechanism; a crosswalk hit is a matcher defect.",
  ].join("\n");

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.INGEST_ALERT_EMAIL;
  if (!apiKey || !to) {
    console.error(
      `[identity-split-scan] ALERT (email not configured — set RESEND_API_KEY + INGEST_ALERT_EMAIL):\n${body}`
    );
    return { sent: false, reason: "RESEND_API_KEY/INGEST_ALERT_EMAIL not set; logged instead" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: ALERT_FROM,
        to: to.split(",").map((s) => s.trim()),
        subject:
          report.crosswalk_hit_count > 0
            ? `[EPD] Identity-split scan — CROSSWALK FAILURE: ${report.crosswalk_hit_count} split(s) at Toast store(s)`
            : `[EPD] Identity-split scan — ${report.hit_count} probable split(s)`,
        text: body,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error(`[identity-split-scan] Resend ${res.status}: ${t.slice(0, 300)}\n${body}`);
      return { sent: false, reason: `resend ${res.status}` };
    }
    return { sent: true, reason: "sent via resend" };
  } catch (err) {
    console.error(
      `[identity-split-scan] send failed: ${err instanceof Error ? err.message : String(err)}\n${body}`
    );
    return { sent: false, reason: "send threw; logged instead" };
  }
}
