import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { runCpSurveySync } from "@/lib/ingest/culture-pulse/orchestrator";

/**
 * Operator backfill for the CP→EPD survey sync (handoff §5a/§6).
 *
 * Re-pulls one store (or all 8) from an explicit `since` target_monday
 * floor; omitting `since` uses the nightly rolling window. Idempotent:
 * surveys upsert on (location_id,title,sent_date), survey_assignments on
 * (survey_id,employee_id) — re-runs are safe, including over the
 * hand-corrected Houston June weeks (same natural keys).
 *
 * The stale-window backfill after the feed goes live:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "$BASE/api/admin/sync-cp-surveys?location=all&since=2026-01-01"
 *
 * Expect COS/FCOL/HRANCH to still show ~0 completions afterwards — that is
 * the true state (completions are genuinely sparse), not a feed defect.
 *
 * AUTH: Bearer <CRON_SECRET>, mirroring the other /api/admin routes (the
 * middleware bypasses the session check; this handler enforces the token).
 */

export const dynamic = "force-dynamic";
// A full-history pull for all 8 stores is still small (CP volumes are a few
// hundred sends per store lifetime) — well within the ceiling.
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
    const summary = await runCpSurveySync({
      locationCode: locationParam === "all" ? undefined : locationParam,
      since: sinceParam || undefined,
    });
    console.log(`[admin/sync-cp-surveys] done: ${summary.runs} run(s)`, summary.by_status);
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[admin/sync-cp-surveys] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
