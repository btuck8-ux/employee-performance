/**
 * Failure alerting for the nightly ingest.
 *
 * Per the locked Phase 11 spec: ONE summary email when any run is `error`, or
 * when a source that should have data comes back uniformly `empty` (a likely
 * silent failure). The body lists per-source rows in/upserted/skipped and any
 * unmatched-identity list.
 *
 * There is no email provider wired in this repo yet, so this sends via Resend's
 * HTTP API using plain fetch (no new dependency), gated on RESEND_API_KEY +
 * INGEST_ALERT_EMAIL. When those envs are absent it degrades to a loud
 * console.error — and either way every run is already durably captured in the
 * ingest_runs table, so failure visibility never depends on email alone.
 */

import type { RunOutcome } from "./runs";

// ⚠ The onboarding@resend.dev fallback is Resend's SANDBOX sender: it can only
// deliver to the Resend account owner's own signup email — any other recipient
// gets a 403. For real delivery, verify a domain in the Resend account and set
// INGEST_ALERT_FROM (e.g. "EPD Ingest <ingest@loveandsandwiches.com>").
const ALERT_FROM = process.env.INGEST_ALERT_FROM ?? "EPD Ingest <onboarding@resend.dev>";

export interface AlertDecision {
  shouldAlert: boolean;
  reasons: string[];
}

/** Decide whether tonight's run warrants an alert. */
export function decideAlert(runs: RunOutcome[]): AlertDecision {
  const reasons: string[] = [];
  const errors = runs.filter((r) => r.status === "error");
  if (errors.length > 0) {
    reasons.push(`${errors.length} run(s) errored`);
  }
  // A source that ran everywhere but came back uniformly empty is suspicious
  // (e.g. an auth failure that returns 200 + empty, or a broken filter).
  for (const source of ["7shifts_time", "pos_receipts", "toast_sales"] as const) {
    const ofSource = runs.filter((r) => r.source === source);
    if (ofSource.length > 0 && ofSource.every((r) => r.status === "empty")) {
      reasons.push(`all ${source} runs empty (${ofSource.length} location(s))`);
    }
  }
  return { shouldAlert: reasons.length > 0, reasons };
}

function buildBody(runs: RunOutcome[], reasons: string[]): string {
  const lines: string[] = [];
  lines.push(`Nightly 7shifts ingest needs attention: ${reasons.join("; ")}.`);
  lines.push("");
  lines.push("Per-run summary (source · location · status · in/upserted/skipped):");
  for (const r of runs) {
    let line = `  ${r.source} · ${r.location_code} · ${r.status} · ${r.rows_in}/${r.rows_upserted}/${r.rows_skipped}`;
    if (r.error_text) line += `  — ${r.error_text}`;
    lines.push(line);
    const unmatched = (r.detail?.unmatched_seven_shifts_user_ids as number[] | undefined) ?? [];
    if (unmatched.length > 0) {
      lines.push(`      unmatched 7shifts user_ids: ${unmatched.join(", ")}`);
    }
  }
  lines.push("");
  lines.push("Full detail: select source, status, started_at, detail from ingest_runs order by started_at desc limit 24;");
  return lines.join("\n");
}

export interface AlertResult {
  sent: boolean;
  reason: string;
}

/**
 * Send the summary email if warranted; otherwise no-op. Never throws.
 *
 * `extraReasons` carries alert conditions computed outside the pure decideAlert()
 * pass — currently the per-location empty-streak guard (streak.ts), which needs
 * a DB lookup the orchestrator does before calling here. Any non-empty
 * extraReasons forces an alert even when decideAlert() alone would stay quiet.
 */
export async function maybeSendFailureAlert(
  runs: RunOutcome[],
  extraReasons: string[] = []
): Promise<AlertResult> {
  const decision = decideAlert(runs);
  const reasons = [...decision.reasons, ...extraReasons];
  if (reasons.length === 0) return { sent: false, reason: "no alert condition" };

  const body = buildBody(runs, reasons);
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.INGEST_ALERT_EMAIL;

  if (!apiKey || !to) {
    console.error(
      `[ingest/alert] ALERT (email not configured — set RESEND_API_KEY + INGEST_ALERT_EMAIL):\n${body}`
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
        subject: `[EPD] Nightly ingest alert — ${reasons.join("; ")}`,
        text: body,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      const hint =
        res.status === 403 && !process.env.INGEST_ALERT_FROM
          ? " — sandbox sender onboarding@resend.dev can only deliver to the Resend account owner's email; verify a domain and set INGEST_ALERT_FROM to fix"
          : "";
      console.error(`[ingest/alert] Resend ${res.status}${hint}: ${t.slice(0, 300)}\n${body}`);
      return { sent: false, reason: `resend ${res.status}${hint}` };
    }
    return { sent: true, reason: "sent via resend" };
  } catch (err) {
    console.error(`[ingest/alert] send failed: ${err instanceof Error ? err.message : String(err)}\n${body}`);
    return { sent: false, reason: "send threw; logged instead" };
  }
}
