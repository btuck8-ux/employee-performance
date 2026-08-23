import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { sendFatalAlert } from "@/lib/ingest/sevenshifts/alert";
import { runToastLaborIngest } from "@/lib/ingest/toast/labor";

/**
 * Nightly Toast Labor punch sync (workstream I, rulings 2026-08-23).
 *
 * Lands each Toast store's clock-in/outs in toast_time_entries (mig 055) and
 * runs the crosswalk auto-matcher (email + guarded behavioural). NEVER
 * writes time_entries and never flips actuals_source — the punch table runs
 * in parallel until the switch is separately decided (see labor.ts header).
 *
 * Scheduled via vercel.json at 09:55 UTC — after the 7shifts/CP family
 * (09:00–09:45) so tonight's scheduled rows exist before the behavioural
 * matcher reads scheduled-vs-punch, and before ingest-toast-kitchen (10:00)
 * so the two Toast pulls don't share a rate-limit window. A store's FIRST
 * run backfills from its Toast go-live (the cp_schedule precedent: the
 * first nightly IS the backfill; /api/admin/backfill-toast-labor is the
 * operator lever for re-runs).
 *
 * Proxy-exempt under /api/cron/*; enforces its own Bearer <CRON_SECRET>.
 */

export const dynamic = "force-dynamic";
// 7 stores × (roster pull + ≤2-chunk window + matcher DB reads); the
// worst case is 7 first-run backfills ≈ well under the ceiling.
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  try {
    const summary = await runToastLaborIngest();
    console.log(
      `[sync-toast-labor] done: ${summary.runs} runs across ${summary.locations} locations`,
      summary.by_status
    );
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sync-toast-labor] fatal:", message);
    // Fatal before any ingest_runs row exists — the run-outcome alert is
    // blind to it; email from the catch itself (2026-08-14 outage pattern).
    await sendFatalAlert("/api/cron/sync-toast-labor", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
