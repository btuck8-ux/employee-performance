/**
 * Shared env-gated Resend delivery for ingest alerts.
 *
 * Extracted from sevenshifts/alert.ts (2026-09-02) so the ledger-wide
 * recompute-failure sweep can send through the same path without a third
 * copy of the fetch. Behavior is unchanged: gated on RESEND_API_KEY +
 * INGEST_ALERT_EMAIL, degrades to a loud console.error when they are absent
 * or the send fails — the finding must never depend on email alone.
 */

// ⚠ The onboarding@resend.dev fallback is Resend's SANDBOX sender: it can only
// deliver to the Resend account owner's own signup email — any other recipient
// gets a 403. For real delivery, verify a domain in the Resend account and set
// INGEST_ALERT_FROM (e.g. "EPD Ingest <ingest@loveandsandwiches.com>").
const ALERT_FROM = process.env.INGEST_ALERT_FROM ?? "EPD Ingest <onboarding@resend.dev>";

export interface AlertResult {
  sent: boolean;
  reason: string;
}

/**
 * Send an alert email; never throws. `logLabel` prefixes the console fallback
 * (e.g. "ingest/alert", "recompute-sweep").
 */
export async function sendAlertEmail(
  subject: string,
  body: string,
  logLabel: string
): Promise<AlertResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.INGEST_ALERT_EMAIL;

  if (!apiKey || !to) {
    console.error(
      `[${logLabel}] ALERT (email not configured — set RESEND_API_KEY + INGEST_ALERT_EMAIL):\n${body}`
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
        subject,
        text: body,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      const hint =
        res.status === 403 && !process.env.INGEST_ALERT_FROM
          ? " — sandbox sender onboarding@resend.dev can only deliver to the Resend account owner's email; verify a domain and set INGEST_ALERT_FROM to fix"
          : "";
      console.error(`[${logLabel}] Resend ${res.status}${hint}: ${t.slice(0, 300)}\n${body}`);
      return { sent: false, reason: `resend ${res.status}${hint}` };
    }
    return { sent: true, reason: "sent via resend" };
  } catch (err) {
    console.error(
      `[${logLabel}] send failed: ${err instanceof Error ? err.message : String(err)}\n${body}`
    );
    return { sent: false, reason: "send threw; logged instead" };
  }
}
