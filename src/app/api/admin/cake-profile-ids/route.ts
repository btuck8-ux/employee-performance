import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { cakeLocation } from "@/lib/ingest/cake/nola-location";

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

export async function GET(request: Request) {
  // Dedicated harvester token (least privilege); falls back to CRON_SECRET so
  // nothing breaks before CAKE_HARVEST_TOKEN is set. Once set, only it is accepted.
  const denied = requireBearer(request, process.env.CAKE_HARVEST_TOKEN ?? process.env.CRON_SECRET, "CAKE_HARVEST_TOKEN/CRON_SECRET");
  if (denied) return denied;

  try {
    const supabase = createAdminClient();
    const nolaId = (await cakeLocation(supabase)).id;
    const { data, error } = await supabase
      .from("cake_profile_crosswalk")
      .select("cake_profile_id, location_id");
    if (error) throw new Error(error.message);

    const profile_ids = Array.from(
      new Set(
        (data ?? [])
          .filter((r) => (r.location_id as string) === nolaId)
          .map((r) => Number(r.cake_profile_id))
      )
    ).sort((a, b) => a - b);

    return NextResponse.json({
      profile_ids,
      count: profile_ids.length,
      location_id: nolaId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
