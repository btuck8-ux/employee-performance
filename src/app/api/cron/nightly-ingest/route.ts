import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { runNightlyIngest } from "@/lib/ingest/sevenshifts/orchestrator";

/**
 * Nightly 7shifts auto-ingest (Phase 11).
 *
 * Fans out the 7shifts trio — time punches, 7tasks summary, POS receipts —
 * across all wired locations, landing rows through the same upsert + recompute
 * path as the manual CSV imports. One ingest_runs row per source x location.
 *
 * Scheduled via vercel.json cron at 09:00 UTC (~2-3 AM Phoenix, after close +
 * POS sync). Proxy-exempt under /api/cron/* (see src/proxy.ts); this
 * handler enforces its own Authorization: Bearer <CRON_SECRET>, which Vercel
 * Cron forwards automatically.
 *
 * Returns the run summary JSON. Failures are also captured in ingest_runs and,
 * when configured, emailed (see alert.ts).
 */

export const dynamic = "force-dynamic";
// Fan-out + per-location recompute across 8 locations; give it room under the
// Vercel function ceiling.
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  try {
    const summary = await runNightlyIngest();
    console.log(
      `[nightly-ingest] done: ${summary.runs} runs across ${summary.locations} locations`,
      summary.by_status
    );
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[nightly-ingest] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
