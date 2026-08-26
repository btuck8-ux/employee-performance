import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendFatalAlert } from "@/lib/ingest/sevenshifts/alert";

/**
 * Weekly departure-notifier sweep (Tucker's ruling on PR #42 deviation 4,
 * overruling the lever-only design): "a notifier that only runs when
 * someone remembers to run it is the exact failure this sprint has spent a
 * week killing" — 60 people sat dormant up to thirteen months because
 * nothing surfaced them without a human initiating. THQ's formulation
 * applies directly: the knowledge existed both times; only once was it a
 * query.
 *
 * Safe by construction: sweep_departure_candidates() (mig 072) writes
 * departure_candidates ONLY — never employees — and the partial unique
 * open-index makes re-runs no-ops. The POST lever on
 * /api/admin/departure-candidates stays for on-demand runs; the SA queue
 * at /dashboard/admin/departure-candidates is where a human decides.
 *
 * When new candidates surface, the notifier NOTIFIES: one email listing
 * every open candidate with employee codes (the THQ rule — a memo naming
 * a person carries the code or it is not sendable). Same env-gated Resend
 * path as the ingest alerts; the JSON response always carries the counts.
 *
 * Schedule: Mondays 12:10 UTC (vercel.json) — right after the identity-
 * split scan, clear of the ingest (~09:00–10:15 UTC) and GH-Action
 * (~13:30–14:00 UTC) windows. AUTH: Bearer <CRON_SECRET>.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ALERT_FROM =
  process.env.INGEST_ALERT_FROM ?? "EPD Ingest <onboarding@resend.dev>";

interface OpenCandidate {
  days_dormant: number;
  last_worked_at: string | null;
  last_scheduled_at: string | null;
  employees: {
    employee_code: string;
    employee_name: string;
    locations: { location_code: string } | null;
  } | null;
}

async function maybeSendSweepAlert(
  newlySurfaced: number,
  open: OpenCandidate[]
): Promise<{ sent: boolean; reason: string }> {
  if (newlySurfaced === 0) return { sent: false, reason: "nothing newly surfaced" };

  const body = [
    `Weekly departure sweep surfaced ${newlySurfaced} new candidate(s). ${open.length} now open for review:`,
    "",
    ...open.map((c) => {
      const e = c.employees;
      return `  ${e?.employee_name ?? "?"} (${e?.employee_code ?? "?"}, ${e?.locations?.location_code ?? "?"}) — ${c.days_dormant}d dormant, last worked ${c.last_worked_at ?? "never"}, last scheduled ${c.last_scheduled_at ?? "never"}`;
    }),
    "",
    "The sweep wrote departure_candidates only — nobody was deactivated. Decide at /dashboard/admin/departure-candidates (dismiss or deactivate person-level).",
  ].join("\n");

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.INGEST_ALERT_EMAIL;
  if (!apiKey || !to) {
    console.error(
      `[departure-sweep] ALERT (email not configured — set RESEND_API_KEY + INGEST_ALERT_EMAIL):\n${body}`
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
        subject: `[EPD] Departure sweep — ${newlySurfaced} new candidate(s) await review`,
        text: body,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error(`[departure-sweep] Resend ${res.status}: ${t.slice(0, 300)}\n${body}`);
      return { sent: false, reason: `resend ${res.status}` };
    }
    return { sent: true, reason: "sent via resend" };
  } catch (err) {
    console.error(
      `[departure-sweep] send failed: ${err instanceof Error ? err.message : String(err)}\n${body}`
    );
    return { sent: false, reason: "send threw; logged instead" };
  }
}

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("sweep_departure_candidates");
    if (error) throw new Error(`sweep rpc: ${error.message}`);
    const newlySurfaced = Number(data ?? 0);

    const { data: openRows, error: openError } = await supabase
      .from("departure_candidates")
      .select(
        "days_dormant, last_worked_at, last_scheduled_at, employees(employee_code, employee_name, locations(location_code))"
      )
      .eq("status", "open")
      .order("days_dormant", { ascending: false });
    if (openError) throw new Error(`open read: ${openError.message}`);
    const open = (openRows ?? []) as unknown as OpenCandidate[];

    const alert = await maybeSendSweepAlert(newlySurfaced, open);
    console.log("[departure-sweep] completed", {
      newly_surfaced: newlySurfaced,
      open_total: open.length,
      alert,
    });
    return NextResponse.json({
      sweep: "departure-notifier",
      newly_surfaced: newlySurfaced,
      open_total: open.length,
      alert,
      note: "Notifier only — wrote departure_candidates; employees untouched.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[departure-sweep] fatal:", message);
    await sendFatalAlert("/api/cron/departure-sweep", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
