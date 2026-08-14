import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { runCpScheduleSync } from "@/lib/ingest/culture-pulse/schedule-orchestrator";

/**
 * Operator lever for the CP→EPD schedule sync (mirrors admin/sync-cp-surveys).
 *
 * Re-pulls one store (or all 8) from an explicit `since` floor; omitting
 * `since` uses the nightly window (which itself backfills from 2026-06-01 on
 * a location's first run). Idempotent: time_entries upsert on
 * (employee_id, entry_date, entry_type) — re-runs are safe.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "$BASE/api/admin/sync-cp-schedules?location=all&since=2026-06-01"
 *
 * AUTH: Bearer <CRON_SECRET>, mirroring the other /api/admin routes (the
 * proxy bypasses the session check; this handler enforces the token).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SINCE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const locationParam = (url.searchParams.get("location") ?? "").trim();
  const sinceParam = (url.searchParams.get("since") ?? "").trim();

  if (!locationParam) {
    return NextResponse.json(
      { error: "Missing ?location=<location_code|all>" },
      { status: 400 }
    );
  }
  if (sinceParam && !SINCE_RE.test(sinceParam)) {
    return NextResponse.json({ error: "?since must be YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const summary = await runCpScheduleSync({
      locationCode: locationParam === "all" ? undefined : locationParam,
      since: sinceParam || undefined,
    });
    console.log(`[admin/sync-cp-schedules] done: ${summary.runs} run(s)`, summary.by_status);
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[admin/sync-cp-schedules] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
