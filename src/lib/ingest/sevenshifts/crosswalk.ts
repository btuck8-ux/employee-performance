import type { SupabaseClient } from "@supabase/supabase-js";

/** The service-role client used across the ingest path (createAdminClient()). */
export type AdminClient = SupabaseClient;

/** One location's 7shifts wiring, read from the migration-030 crosswalk. */
export interface LocationCrosswalk {
  id: string; // EPD locations.id (uuid)
  name: string;
  location_code: string;
  company_id: number; // seven_shifts_company_id
  seven_shifts_location_id: number;
  pos_via_7shifts: boolean;
  /**
   * Which feed owns this location's worked actuals (migration 033).
   * '7shifts' (default) -> the nightly 7shifts_time pull; 'cake' -> the CAKE
   * labor feed. The orchestrator skips 7shifts_time when this is not '7shifts'.
   */
  actuals_source: "7shifts" | "cake";
}

/**
 * Load the 8-row crosswalk. Only locations with both 7shifts ids set are
 * returned (a location not yet wired is skipped, not errored). Ordered by
 * location_code for stable, readable run logs.
 */
export async function loadCrosswalk(
  supabase: AdminClient
): Promise<LocationCrosswalk[]> {
  const { data, error } = await supabase
    .from("locations")
    .select(
      "id, name, location_code, seven_shifts_company_id, seven_shifts_location_id, pos_via_7shifts, actuals_source"
    )
    .not("seven_shifts_company_id", "is", null)
    .not("seven_shifts_location_id", "is", null)
    .order("location_code");

  if (error) {
    throw new Error(`Failed to load 7shifts crosswalk: ${error.message}`);
  }

  return (data ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    location_code: r.location_code as string,
    company_id: Number(r.seven_shifts_company_id),
    seven_shifts_location_id: Number(r.seven_shifts_location_id),
    pos_via_7shifts: Boolean(r.pos_via_7shifts),
    actuals_source: (r.actuals_source as string) === "cake" ? "cake" : "7shifts",
  }));
}
