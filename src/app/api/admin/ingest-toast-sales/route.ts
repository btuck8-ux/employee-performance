import { NextResponse } from "next/server";
import { runToastSalesIngest } from "@/lib/ingest/toast/orchestrator";

/**
 * Operator catch-up for the Toast sales feed — the seam right after the Cake
 * backfill (handoff-co-sales-toast-plus-cake-2026-07-26.md §2.2).
 *
 * Re-pulls one store (or all wired stores) from an explicit `since` date, or
 * from each store's normal incremental window when `since` is omitted. The
 * fetcher clamps every window to the store's toast_sales_start_date floor,
 * so even a too-early `since` cannot pull business dates the Cake backfill
 * owns. Idempotent: sales_records upserts on its natural key and the
 * recompute is deterministic.
 *
 * AUTH: Bearer <CRON_SECRET>, mirroring the other /api/admin routes (the
 * middleware bypasses the session check; this handler enforces the token).
 * Invoke per store for the go-live catch-up:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "$BASE/api/admin/ingest-toast-sales?location=COS&since=2026-07-07"
 *
 * or all stores at once (each clamped to its own go-live):
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "$BASE/api/admin/ingest-toast-sales?location=all&since=2026-07-01"
 */

export const dynamic = "force-dynamic";
// A month-wide catch-up for one store fits comfortably; `location=all` over
// the full go-live window also stays under the ceiling (~26 dates × 6 stores
// of page fetches + recompute), matching the Cake backfill scale.
export const maxDuration = 300;

const SINCE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
    return NextResponse.json(
      { error: "?since must be YYYY-MM-DD" },
      { status: 400 }
    );
  }

  try {
    const summary = await runToastSalesIngest({
      locationCode: locationParam === "all" ? undefined : locationParam,
      since: sinceParam || undefined,
    });
    console.log(
      `[admin/ingest-toast-sales] done: ${summary.runs} run(s)`,
      summary.by_status
    );
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[admin/ingest-toast-sales] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
