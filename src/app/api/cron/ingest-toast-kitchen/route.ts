import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { runToastKitchenIngest } from "@/lib/ingest/toast/kitchen-ingest";

/**
 * Nightly Toast Kitchen ticket-time ingest (handoff 2026-07-28 §5.4) — the 6
 * CO stores + HOU, per the toast_kitchen_enabled flag.
 *
 * Rolling 3-local-day window per store so late bumps and edits land. One
 * ingest_runs row per store (source 'toast_kitchen'); outcomes feed the same
 * failure alert + empty-streak guard as every other feed. A 204 from the
 * export is treated as a hard error (Toast RMS Pro+ subscription gate), never
 * an empty night.
 *
 * Scheduled via vercel.json at 10:00 UTC — deliberately last: nightly-ingest
 * 09:00, toast_sales 09:15, guest-feedback+tasks 09:30, culture_pulse 09:45,
 * so the labor punches this feed's attribution joins against are already
 * landed. Proxy-exempt under /api/cron/*; this handler enforces its own
 * Authorization: Bearer <CRON_SECRET>, which Vercel Cron forwards.
 */

export const dynamic = "force-dynamic";
// 7 stores × 3 businessDate fetches (~300-600 rows each, unpaginated) +
// recompute; comfortably inside the ceiling.
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  try {
    const summary = await runToastKitchenIngest();
    console.log(
      `[ingest-toast-kitchen] done: ${summary.runs} runs across ${summary.locations} locations`,
      summary.by_status
    );
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ingest-toast-kitchen] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
