import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Returns the CAKE profile ids the nightly harvester should pull, from
 * cake_profile_crosswalk (the authoritative mapping). Keeping the list in the
 * DB — not hardcoded in the GitHub Action — means new CAKE hires flow through
 * the moment they're added to the crosswalk, with no workflow edit.
 *
 * AUTH: Bearer <CRON_SECRET>, same as the other /api/admin routes.
 *
 *   GET /api/admin/cake-profile-ids
 *   -> { profile_ids: number[], count, location_id }
 */

export const dynamic = "force-dynamic";

const NOLA_LOCATION_ID = "570102ad-988f-4972-8475-f2f85a7dc0ae";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("cake_profile_crosswalk")
      .select("cake_profile_id, location_id");
    if (error) throw new Error(error.message);

    const profile_ids = Array.from(
      new Set(
        (data ?? [])
          .filter((r) => (r.location_id as string) === NOLA_LOCATION_ID)
          .map((r) => Number(r.cake_profile_id))
      )
    ).sort((a, b) => a - b);

    return NextResponse.json({
      profile_ids,
      count: profile_ids.length,
      location_id: NOLA_LOCATION_ID,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
