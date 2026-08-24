import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  loadToastLaborLocations,
  reconcileAttributions,
} from "@/lib/ingest/toast/labor";

/**
 * One-shot attribution reconciler (defect 2026-08-24 §5e) — re-aligns every
 * stored Toast punch with the CURRENT crosswalk, DB-only (no Toast API
 * calls). The operator lever for drift after out-of-band crosswalk edits
 * (the 2026-08-24 manual correction left 31 punch rows pointing at the
 * wrong employee until re-stamped by hand). Idempotent; the nightly runs
 * the same pass per store anyway — this exists so a fix never has to wait
 * for 09:55 UTC.
 *
 * AUTH: Bearer <CRON_SECRET>.
 *   GET /api/admin/restamp-toast-attributions[?location_code=COS]
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const locationCode = url.searchParams.get("location_code");

  try {
    const supabase = createAdminClient();
    let locations = await loadToastLaborLocations(supabase);
    if (locationCode) {
      locations = locations.filter((l) => l.location_code === locationCode);
      if (locations.length === 0) {
        return NextResponse.json(
          { error: `No Toast-labor location "${locationCode}".` },
          { status: 400 }
        );
      }
    }
    const results = [];
    for (const loc of locations) {
      const r = await reconcileAttributions(supabase, loc.id);
      results.push({ location_code: loc.location_code, ...r });
    }
    return NextResponse.json({ report: "restamp-toast-attributions", results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[restamp-toast-attributions] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
