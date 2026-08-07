import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { runGuestFeedbackHarvest } from "@/lib/ingest/guest-feedback/harvest";

/**
 * Nightly unified guest-feedback harvester (handoff §4b).
 *
 * Pulls Tattle snapshots and Tattle online reviews for every non-excluded store on a rolling per-(source, location) incremental
 * window, landing rows through the same ingest*ForLocation compute as the manual
 * uploads. One ingest_runs row per source × location; failures roll into the
 * shared alert (alert.ts) + empty-streak guard (streak.ts).
 *
 * Scheduled via vercel.json cron at 09:30 UTC — AFTER nightly-ingest (09:00) so
 * worked time lands first and attribution resolves same-night. Middleware-exempt
 * under /api/cron/*; this handler enforces its own Bearer <CRON_SECRET>, which
 * Vercel Cron forwards automatically.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  try {
    // 7Tasks rejoined the server-side nightly 2026-07-27: Source C pulls the
    // PUBLIC 7shifts API (tasks-api-source.ts, token auth — the labor client),
    // so all three sources are env-token again.
    const summary = await runGuestFeedbackHarvest({
      locationCodes: "all",
      sources: ["tattle", "reviews", "tasks"],
    });
    console.log(
      `[harvest-cron] done: ${summary.runs} runs across ${summary.locations} locations`,
      summary.by_status
    );
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[harvest-cron] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
