import { NextResponse } from "next/server";
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
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 7Tasks rejoined the server-side nightly 2026-07-27: Source C now pulls
    // the PUBLIC 7shifts API (tasks-api-source.ts, token auth — the labor
    // client), so all three sources are env-token again. The Playwright
    // harness (7tasks-nightly.yml, 13:45 UTC) runs in PARALLEL during the
    // cutover window; both paths are idempotent on the same natural keys.
    // Once parity holds for a few nights, disable the harness workflow
    // (handoff 2026-07-27 §4) — do not remove it, it is the fallback.
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
