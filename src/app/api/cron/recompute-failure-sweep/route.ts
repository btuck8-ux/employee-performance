import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { sendFatalAlert } from "@/lib/ingest/sevenshifts/alert";
import { createAdminClient } from "@/lib/supabase/admin";
import { runRecomputeFailureSweep } from "@/lib/ingest/recompute-sweep";

/**
 * Daily recompute-failure ledger sweep (detector Layer 2, 2026-09-02).
 *
 * Reads ingest_runs for the window since the last sweep and alerts on ANY
 * run carrying recompute failures in its detail, regardless of the run's
 * status or which writer logged it. Closes the 2026-09-01 hole: 329 of 416
 * failures rode status='success' runs (and CAKE — NOLA's only worked-actuals
 * source — has no alert wiring at all), so four-fifths of a total recompute
 * outage was silent for a full cycle.
 *
 * Scheduled 14:15 UTC: after the nightly ingest family (~09:00–10:15) and
 * the GitHub-Action window (~13:30–14:00), so one pass covers the whole
 * cycle. Window state lives in app_settings ('recompute_sweep_high_water'),
 * not wall-clock lookback — each ledger row is judged exactly once.
 *
 * Proxy-exempt under /api/cron/*; this handler enforces its own
 * Authorization: Bearer <CRON_SECRET>, which Vercel Cron forwards.
 */

export const dynamic = "force-dynamic";
// One bounded ledger read + at most one email + one key/value upsert.
export const maxDuration = 60;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  try {
    const supabase = createAdminClient();
    const result = await runRecomputeFailureSweep(supabase);
    const s = result.summary;
    console.log(
      `[recompute-sweep] ${s.shouldAlert ? "ALERT" : "clean"}: ` +
        `${s.exact ? "" : "≥ "}${s.totalFailures} failure(s) across ${s.failingRuns} of ${s.sweptRuns} run(s) ` +
        `in (${result.windowFrom} … ${result.windowTo}]` +
        (result.alert ? ` — alert: ${result.alert.reason}` : "")
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[recompute-failure-sweep] fatal:", message);
    // The sweep IS the safety net — a sweep that dies silently recreates the
    // exact blind spot it exists to close. sendFatalAlert never throws.
    await sendFatalAlert("/api/cron/recompute-failure-sweep", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
