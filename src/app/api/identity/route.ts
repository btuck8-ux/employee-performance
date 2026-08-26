import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isKnownLocationCode } from "@/lib/location-codes";

/**
 * EPD -> Culture Pulse IDENTITY feed.
 *
 * Read-only REST endpoint backed by the `v_employee_identity` view (migration
 * 037): the full minted roster keyed by `employee_code` + `location_code`, with
 * `seven_shifts_user_id` / `email` / `employee_name` as CP's directory-match
 * keys. Unlike /api/scores (which joins performance_records and so omits
 * codeable-but-unscored new hires), this feed is sourced straight from
 * `employees`, so a new hire appears the moment EPD mints their code. CP polls
 * this to auto-populate employee_directory.employee_code — retiring the manual
 * read-code -> stamp -> backfill hop. See spec-epd-cp-identity-sync-2026-07-20.md
 * (authoritative).
 *
 * Auth: `Authorization: Bearer <SCORES_FEED_TOKEN>` — reuses the scores-feed
 * token (same EPD->CP consumer + trust boundary). Queries via the service-role
 * client (bypasses RLS); allowlisted in proxy.ts the same way as /api/scores.
 *
 * Mig 071 (epd_role spec 2026-08-26 §4/§8): `is_general_manager` is now
 * DERIVED (epd_role = 'manager') — same name, type, and semantics, only
 * where the truth lives moved — and `epd_role` rides as the 11th column,
 * additive, the shared five-value tier vocabulary partners adopt off the
 * wire. ⚠️ 'manager' here means GENERAL MANAGER (employment tier), never
 * users.role's app-permission 'manager'. Pinned by
 * identity-feed-contract.test.ts.
 */

export const dynamic = "force-dynamic";


// PostgREST hard-caps a single page at 1000 rows; clamp limit to it.
const MAX_LIMIT = 1000;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.SCORES_FEED_TOKEN, "SCORES_FEED_TOKEN");
  if (denied) return denied;

  const url = new URL(request.url);
  const locationCode = url.searchParams.get("location_code");
  const since = url.searchParams.get("since");
  const includeInactive = url.searchParams.get("include_inactive") === "true";

  // limit/offset: parse defensively. NaN -> default; then clamp to bounds.
  const rawLimit = Number(url.searchParams.get("limit") ?? MAX_LIMIT);
  const limit = Number.isNaN(rawLimit)
    ? MAX_LIMIT
    : Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT);
  const rawOffset = Number(url.searchParams.get("offset") ?? 0);
  const offset = Number.isNaN(rawOffset) ? 0 : Math.max(Math.trunc(rawOffset), 0);

  if (locationCode) {
    // The code check reads public.locations; a failed read must return the
    // route's JSON error shape, never an unhandled 500 (Codex should-fix).
    let known: boolean;
    try {
      known = await isKnownLocationCode(locationCode);
    } catch (err) {
      console.error("[identity-feed] location codes read failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { error: "Internal error resolving locations" },
        { status: 500 }
      );
    }
    if (!known) {
      return NextResponse.json({ error: "Unknown location_code" }, { status: 400 });
    }
  }
  if (since && Number.isNaN(Date.parse(since))) {
    return NextResponse.json({ error: "Invalid since timestamp" }, { status: 400 });
  }

  const supabase = createAdminClient();

  let query = supabase.from("v_employee_identity").select("*", { count: "exact" });
  if (locationCode) query = query.eq("location_code", locationCode);
  // Default to active-only (matches the scores view); ?include_inactive=true
  // returns archived rows too, for full reconciliation pulls.
  if (!includeInactive) query = query.eq("active", true);
  if (since) query = query.gte("updated_at", since);
  query = query
    .order("employee_code", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) {
    // Log the underlying DB error server-side (Vercel function logs) but never
    // leak PostgREST/Postgres internals to the external CP consumer.
    console.error("[identity-feed] query failed", {
      location_code: locationCode,
      since,
      include_inactive: includeInactive,
      limit,
      offset,
      message: error.message,
    });
    return NextResponse.json(
      { error: "Internal error retrieving identity" },
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
