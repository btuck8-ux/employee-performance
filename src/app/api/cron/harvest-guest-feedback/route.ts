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
    // 7Tasks now arrives via the 7shifts Playwright harness (GitHub Actions →
    // /api/admin/import-tasks-csv), mirroring the CAKE nightly. So the Vercel
    // cron runs only the env-token sources here; including "tasks" would fire the
    // retired dashboard-cookie path and error every night.
    const summary = await runGuestFeedbackHarvest({
      locationCodes: "all",
      sources: ["tattle", "reviews"],
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
