import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { runCpScheduleSync } from "@/lib/ingest/culture-pulse/schedule-orchestrator";

/**
 * Nightly CP→EPD scheduled-shifts sync (kickoff-ui-rbac-c-brand-2026-08-14.md §3).
 *
 * Lands each store's Culture Pulse weekly_schedule_entries as
 * time_entries(entry_type='scheduled') — the rows attendance / on-time / TIS
 * score against — then recomputes the touched (employee × quarter) set. One
 * ingest_runs row per store (source 'cp_schedule', migration 049).
 *
 * Scheduled via vercel.json at 09:40 UTC — after the guest-feedback harvest
 * (09:30) and before cp-surveys (09:45), so worked time from nightly-ingest
 * (09:00) has landed before the recompute here reads scheduled-vs-worked.
 * Proxy-exempt under /api/cron/*; this handler enforces its own
 * Authorization: Bearer <CRON_SECRET>, which Vercel Cron forwards.
 *
 * A store's FIRST run backfills from 2026-06-01 (the scheduled-shifts gap),
 * so no separate backfill step exists — the first nightly is the backfill.
 */

export const dynamic = "force-dynamic";
// 8 stores × (a ~5-week CP window + per-employee recompute); the first-run
// backfill (Jun 1 → today+21d, ~1,600 rows/store max) is the worst case and
// still lands well under the ceiling.
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  try {
    const summary = await runCpScheduleSync();
    console.log(
      `[sync-cp-schedules] done: ${summary.runs} runs across ${summary.locations} locations`,
      summary.by_status
    );
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sync-cp-schedules] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
