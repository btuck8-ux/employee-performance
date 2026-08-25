import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { runToastKitchenIngest } from "@/lib/ingest/toast/kitchen-ingest";

/**
 * Operator backfill for the Toast Kitchen feed (handoff 2026-07-28 §5.4).
 *
 * Pulls one store (or all kitchen-enabled stores) over an explicit inclusive
 * from/to local-date window; each store is clamped to its go-live floor —
 * its OWN toast_sales_start_date, no constant fallback (§1, addendum
 * 2026-08-25) — so kitchen history starts exactly where Toast history
 * exists. Idempotent: rows upsert on the natural
 * (location, ticket, selection, station, level) key and the recompute is
 * deterministic — re-running a window is 0 inserted, N updated.
 *
 * AUTH: Bearer <CRON_SECRET>. Backfill scope per handoff: go-live → today is
 * ~20-28 days × 7 stores ≈ ~200 export calls.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "$BASE/api/admin/ingest-toast-kitchen?location=all&from=2026-07-01&to=2026-07-28"
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const locationParam = (url.searchParams.get("location") ?? "").trim();
  const fromParam = (url.searchParams.get("from") ?? "").trim();
  const toParam = (url.searchParams.get("to") ?? "").trim();

  if (!locationParam) {
    return NextResponse.json(
      { error: "Missing ?location=<location_code|all>" },
      { status: 400 }
    );
  }
  for (const [name, v] of [
    ["from", fromParam],
    ["to", toParam],
  ] as const) {
    if (v && !DATE_RE.test(v)) {
      return NextResponse.json({ error: `?${name} must be YYYY-MM-DD` }, { status: 400 });
    }
  }

  try {
    const summary = await runToastKitchenIngest({
      locationCode: locationParam === "all" ? undefined : locationParam,
      from: fromParam || undefined,
      to: toParam || undefined,
    });
    console.log(
      `[admin/ingest-toast-kitchen] done: ${summary.runs} run(s)`,
      summary.by_status
    );
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[admin/ingest-toast-kitchen] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
