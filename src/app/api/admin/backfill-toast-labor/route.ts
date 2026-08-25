import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { runToastLaborIngest } from "@/lib/ingest/toast/labor";

/**
 * Beat-1 backfill / operator catch-up lever for the Toast Labor feed
 * (workstream I §5.5). The nightly's FIRST run already backfills from each
 * store's go-live (cp_schedule precedent), so this lever exists for re-runs
 * after crosswalk growth, single-store catch-ups, and pulling the window
 * again after an incident — the backfill-roles/backfill-worked-time
 * operator-lever precedent (deliberate, not dead code).
 *
 * Writes toast_time_entries + toast_employee_crosswalk ONLY — never
 * time_entries, never actuals_source (labor.ts header; pinned by test).
 * No historical recompute rides this (ruling §6): performance_records are
 * untouched until the C4 decision.
 *
 * AUTH: Bearer <CRON_SECRET>.
 *   GET /api/admin/backfill-toast-labor
 *     ?location_code=COS   restrict to one store (default: all 7)
 *     &since=YYYY-MM-DD    window start (floored at each store's go-live;
 *                          default: each store's OWN go-live — deliberately
 *                          NO constant default. A hardcoded July-1st default
 *                          here out-maxed Houston's 2026-04-30 go-live and
 *                          hid 501 punches for two months; §1, addendum
 *                          2026-08-25)
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const locationCode = url.searchParams.get("location_code") ?? undefined;
  const since = url.searchParams.get("since") ?? undefined;

  try {
    const summary = await runToastLaborIngest({ locationCode, since });
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[backfill-toast-labor] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
