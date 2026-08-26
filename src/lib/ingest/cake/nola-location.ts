import type { AdminClient } from "../sevenshifts/crosswalk";

/**
 * Resolve the CAKE-actuals store at runtime, keyed on the fact the database
 * OWNS: `locations.actuals_source = 'cake'` (mig 033/061). Previously keyed
 * on a hardcoded location-code literal — the copy-of-a-DB-fact defect class
 * (LOCATION_CODES packet 2026-08-26). The CAKE feed is single-store by
 * design, so `.single()` is the loud guard: a second cake store (or none)
 * errors here instead of silently mis-landing a timesheet.
 */
export async function cakeLocation(
  supabase: AdminClient
): Promise<{ id: string; location_code: string }> {
  const { data, error } = await supabase
    .from("locations")
    .select("id, location_code")
    .eq("actuals_source", "cake")
    .single();
  if (error || !data?.id) {
    throw new Error(
      `cake location lookup failed (expected exactly one locations row with actuals_source='cake'): ${error?.message ?? "no row"}`
    );
  }
  return { id: data.id as string, location_code: data.location_code as string };
}
