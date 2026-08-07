import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { runCpSurveySync } from "@/lib/ingest/culture-pulse/orchestrator";

/**
 * Nightly CP→EPD survey sync (handoff-cp-survey-feed-EXECUTE-2026-07-26.md).
 *
 * Pulls each store's Culture Pulse sends + completions and lands them as
 * surveys + survey_assignments — the assigned pool is CP's delivered-send
 * log, replacing the worked-pool denominator at the root. One ingest_runs
 * row per store (source 'culture_pulse').
 *
 * Scheduled via vercel.json at 09:45 UTC — after nightly-ingest (09:00),
 * the Toast sales feed (09:15), and the guest-feedback harvest (09:30), so
 * worked time and guest data land before the recompute here runs.
 * Middleware-exempt under /api/cron/*; this handler enforces its own
 * Authorization: Bearer <CRON_SECRET>, which Vercel Cron forwards.
 *
 * Empty nights are NORMAL (weekly send cadence); the orchestrator's
 * staleness check alerts if a store goes >9 days without a successful pull.
 */

export const dynamic = "force-dynamic";
// 8 stores × (a rolling 35-day CP window + per-employee recompute); small
// volumes (2–7 sends/store/week) keep this far under the ceiling.
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  try {
    const summary = await runCpSurveySync();
    console.log(
      `[sync-cp-surveys] done: ${summary.runs} runs across ${summary.locations} locations`,
      summary.by_status
    );
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sync-cp-surveys] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
