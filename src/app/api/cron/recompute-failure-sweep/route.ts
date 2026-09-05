import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { sendFatalAlert } from "@/lib/ingest/sevenshifts/alert";
import { createAdminClient } from "@/lib/supabase/admin";
import { runRecomputeFailureSweep } from "@/lib/ingest/recompute-sweep";
import { runFrozenDriftCheck } from "@/lib/ingest/frozen-drift";

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
 * Also hosts the FROZEN-SET DRIFT detector (W4, 2026-09-05) as an
 * independent second detector: it does not depend on ingest activity (it is
 * never skipped when there are no new ingest rows), carries its own alert
 * reason ("frozen-drift" — never merged into the sweep's shouldAlert and
 * never suppressing a recompute-failure alert), and either detector failing
 * leaves the other running and reporting.
 *
 * Proxy-exempt under /api/cron/*; this handler enforces its own
 * Authorization: Bearer <CRON_SECRET>, which Vercel Cron forwards.
 */

export const dynamic = "force-dynamic";
// Two bounded reads + at most two emails + one key/value upsert.
export const maxDuration = 60;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const supabase = createAdminClient();

  // Detector 1: recompute-failure ledger sweep. Its fatal path must not
  // stop the frozen check below, so the catch stays local.
  let sweep: Awaited<ReturnType<typeof runRecomputeFailureSweep>> | null = null;
  let sweepError: string | null = null;
  try {
    sweep = await runRecomputeFailureSweep(supabase);
    const s = sweep.summary;
    console.log(
      `[recompute-sweep] ${s.shouldAlert ? "ALERT" : "clean"}: ` +
        `${s.exact ? "" : "≥ "}${s.totalFailures} failure(s) across ${s.failingRuns} of ${s.sweptRuns} run(s) ` +
        `in (${sweep.windowFrom} … ${sweep.windowTo}]` +
        (sweep.alert ? ` — alert: ${sweep.alert.reason}` : "")
    );
  } catch (err) {
    sweepError = err instanceof Error ? err.message : String(err);
    console.error("[recompute-failure-sweep] fatal:", sweepError);
    // The sweep IS the safety net — a sweep that dies silently recreates the
    // exact blind spot it exists to close. sendFatalAlert never throws.
    await sendFatalAlert("/api/cron/recompute-failure-sweep", sweepError);
  }

  // Detector 2: frozen-set drift. Never throws; a read failure is its own
  // distinct alerted outcome, not a clean result and not a route fatal.
  const frozen = await runFrozenDriftCheck(supabase);
  console.log(
    `[frozen-drift] ${frozen.status}` +
      (frozen.verdict
        ? `: ${frozen.verdict.totalRows} frozen row(s)` +
          (frozen.verdict.drift
            ? ` — ${frozen.verdict.problems.map((p) => `${p.kind}('${p.label}')`).join(", ")}`
            : "")
        : ` — ${frozen.readError}`) +
      (frozen.alert ? ` — alert: ${frozen.alert.reason}` : "")
  );

  const status = sweepError ? 500 : 200;
  return NextResponse.json({ sweep, sweepError, frozenDrift: frozen }, { status });
}
