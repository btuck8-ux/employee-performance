import type { AdminClient } from "../sevenshifts/crosswalk";

/**
 * Resolve NOLA's locations.id at runtime instead of hardcoding the GUID
 * (previously duplicated in the two cake-* admin routes; seeded by migration
 * 027). NOLA is the only cake-actuals store, so the pair is a unique key.
 */
export async function nolaLocationId(supabase: AdminClient): Promise<string> {
  const { data, error } = await supabase
    .from("locations")
    .select("id")
    .eq("location_code", "NOLA")
    .eq("actuals_source", "cake")
    .single();
  if (error || !data?.id) {
    throw new Error(
      `NOLA location lookup failed (location_code='NOLA', actuals_source='cake'): ${error?.message ?? "no row"}`
    );
  }
  return data.id as string;
}
