import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { LOCATION_CODES } from "@/lib/location-codes";

/**
 * EPD -> Culture Pulse performance-scores feed.
 *
 * Read-only REST endpoint backed by the `v_employee_scores` view (and
 * `v_employee_scores_latest` for the default `period=latest`). CP polls this
 * to pull per-employee Customer Service Score + Total Impact Score, joining on
 * `employee_code` (primary, durable key) + `location_code`. See
 * scores-feed-endpoint-handoff.md / epd-scores-feed-handoff.md (authoritative).
 *
 * Auth: `Authorization: Bearer <SCORES_FEED_TOKEN>` — a distinct env from
 * CRON_SECRET, mirroring the cron route's bearer pattern. The route does its
 * own auth and queries via the service-role client (bypasses RLS), so it is
 * allowlisted in middleware.ts the same way as /api/cron.
 */

export const dynamic = "force-dynamic";


// PostgREST hard-caps a single page at 1000 rows; clamp limit to it.
const MAX_LIMIT = 1000;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.SCORES_FEED_TOKEN, "SCORES_FEED_TOKEN");
  if (denied) return denied;

  const url = new URL(request.url);
  const locationCode = url.searchParams.get("location_code");
  const period = url.searchParams.get("period") ?? "latest";
  const since = url.searchParams.get("since");

  // limit/offset: parse defensively. NaN -> default; then clamp to bounds.
  const rawLimit = Number(url.searchParams.get("limit") ?? MAX_LIMIT);
  const limit = Number.isNaN(rawLimit)
    ? MAX_LIMIT
    : Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT);
  const rawOffset = Number(url.searchParams.get("offset") ?? 0);
  const offset = Number.isNaN(rawOffset) ? 0 : Math.max(Math.trunc(rawOffset), 0);

  if (locationCode && !LOCATION_CODES.includes(locationCode)) {
    return NextResponse.json(
      { error: "Unknown location_code" },
      { status: 400 }
    );
  }
  if (since && Number.isNaN(Date.parse(since))) {
    return NextResponse.json(
      { error: "Invalid since timestamp" },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();

  // period=latest -> per-employee latest-period view (DISTINCT ON in SQL, mig 029).
  // period=all or a specific label -> the full history view.
  const view =
    period === "latest" ? "v_employee_scores_latest" : "v_employee_scores";

  let query = supabase.from(view).select("*", { count: "exact" });
  if (locationCode) query = query.eq("location_code", locationCode);
  if (period !== "latest" && period !== "all") {
    query = query.eq("period_label", period);
  }
  if (since) query = query.gte("computed_at", since);
  query = query
    .order("employee_code", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) {
    // Log the underlying DB error server-side (visible in Vercel function logs)
    // but never leak PostgREST/Postgres internals to the external CP consumer.
    console.error("[scores-feed] query failed", {
      view,
      location_code: locationCode,
      period,
      since,
      limit,
      offset,
      message: error.message,
    });
    return NextResponse.json(
      { error: "Internal error retrieving scores" },
      { status: 500 }
    );
  }

  const total = count ?? 0;
  const rows = data ?? [];
  return NextResponse.json({
    data: rows,
    pagination: {
      limit,
      offset,
      count: total,
      has_more: offset + rows.length < total,
    },
  });
}
