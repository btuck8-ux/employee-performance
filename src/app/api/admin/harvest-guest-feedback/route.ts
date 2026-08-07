import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import {
  runGuestFeedbackHarvest,
  ALL_SOURCES,
  type GuestFeedbackSource,
} from "@/lib/ingest/guest-feedback/harvest";

/**
 * Operator/backfill route for the unified guest-feedback harvester (handoff §4a).
 *
 *   GET /api/admin/harvest-guest-feedback
 *       ?location=<CODE|all>          (required; e.g. COS or all)
 *       &since=<YYYY-MM-DD>           (optional backfill floor; omit = rolling)
 *       &sources=<tattle,reviews,tasks>  (optional subset; default all three)
 *
 * This is the "one run backfills too" lever: ?location=all&since=2026-04-01
 * re-pulls every store's Tattle/Reviews/Tasks for Q2, while the nightly cron
 * (no `since`) uses each (source, location)'s rolling incremental window. Every
 * importer upserts on a natural key and replaces attributions only for touched
 * ids, so re-runs are idempotent.
 *
 * AUTH: Bearer <CRON_SECRET>, mirroring /api/admin/backfill-worked-time.
 * /api/admin/* is already exempt from the session proxy; this handler
 * enforces its own CRON_SECRET match.
 */

export const dynamic = "force-dynamic";
// Shared fetch per source + per-(store × source) recompute; give it room under
// the Vercel function ceiling. A quarter-wide backfill across all stores fits.
export const maxDuration = 300;

const VALID_SOURCES = new Set<GuestFeedbackSource>(ALL_SOURCES);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const locationParam = (url.searchParams.get("location") ?? "").trim();
  const sinceParam = (url.searchParams.get("since") ?? "").trim();
  const sourcesParam = (url.searchParams.get("sources") ?? "").trim();

  if (!locationParam) {
    return NextResponse.json(
      { error: "Missing ?location=<location_code|all>" },
      { status: 400 }
    );
  }
  if (sinceParam && !DATE_RE.test(sinceParam)) {
    return NextResponse.json(
      { error: `Invalid ?since="${sinceParam}" (expected YYYY-MM-DD)` },
      { status: 400 }
    );
  }

  let sources: GuestFeedbackSource[] = ALL_SOURCES;
  if (sourcesParam) {
    const requested = sourcesParam.split(",").map((s) => s.trim().toLowerCase());
    const invalid = requested.filter((s) => !VALID_SOURCES.has(s as GuestFeedbackSource));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `Unknown sources: ${invalid.join(", ")} (valid: ${ALL_SOURCES.join(", ")})` },
        { status: 400 }
      );
    }
    sources = requested as GuestFeedbackSource[];
  }

  try {
    const summary = await runGuestFeedbackHarvest({
      locationCodes: locationParam.toLowerCase() === "all" ? "all" : [locationParam],
      since: sinceParam || null,
      sources,
    });
    console.log(
      `[harvest-admin] done: ${summary.runs} runs across ${summary.locations} locations`,
      summary.by_status
    );
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[harvest-admin] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
