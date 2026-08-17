import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { sendFatalAlert } from "@/lib/ingest/sevenshifts/alert";
import { runToastSalesIngest } from "@/lib/ingest/toast/orchestrator";

/**
 * Nightly Toast sales ingest — the 6 CO stores' permanent direct-API sales
 * feed (handoff-co-sales-toast-plus-cake-2026-07-26.md §2).
 *
 * Pulls each store's incremental window from Toast's Orders API and lands
 * rows through the same sales_records upsert + recompute path as the manual
 * POS imports and Houston's 7shifts pos_receipts. One ingest_runs row per
 * store (source 'toast_sales').
 *
 * Scheduled via vercel.json at 09:15 UTC — after the 09:00 nightly-ingest so
 * the evening's 7shifts labor is already landed when the recompute runs, and
 * before the 09:30 guest-feedback harvest. Middleware-exempt under
 * /api/cron/* (src/proxy.ts); this handler enforces its own
 * Authorization: Bearer <CRON_SECRET>, which Vercel Cron forwards.
 */

export const dynamic = "force-dynamic";
// 6 stores × (a night or two of business dates + recompute); well within the
// ceiling nightly, and enough headroom for a multi-day self-heal after an
// outage.
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  try {
    const summary = await runToastSalesIngest();
    console.log(
      `[ingest-toast-sales] done: ${summary.runs} runs across ${summary.locations} locations`,
      summary.by_status
    );
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ingest-toast-sales] fatal:", message);
    // A fatal here usually means the FIRST DB call died — zero ingest_runs
    // rows, so the run-outcome alert is blind to it (2026-08-14 outage).
    // Send the failure email from the catch itself; never throws.
    await sendFatalAlert("/api/cron/ingest-toast-sales", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
