/**
 * CP↔EPD location crosswalk for the survey/schedule feeds.
 *
 * The wiring lives in `public.locations` (mig 074: cp_location_key +
 * cp_location_id — the mig-038 toast_restaurant_guid pattern). The 8-row
 * hardcoded map that used to live here was a copy of a fact the database
 * owns (Tucker 2026-08-26, the FCCSU packet); verified live 2026-07-26
 * before the move, byte-identical after it.
 *
 * NULL cp columns = not CP-synced: the loader SKIPS such stores (the
 * loadCrosswalk precedent — a location not yet wired is skipped, not
 * errored). FCCSU is deliberately unwired: CP carries an inactive
 * `fort_collins_csu` location, and enabling CSU's survey/schedule sync is a
 * CP-side product decision made by a human setting the two columns.
 */

import type { AdminClient } from "../sevenshifts/crosswalk";

/** One synced location: EPD row + its CP wiring. */
export interface CpSyncLocation {
  /** EPD locations.id */
  id: string;
  name: string;
  location_code: string;
  /** locations.timezone — the DB owns the zone; storeTimezone() throws if unset. */
  timezone: string | null;
  /** CP locations.location_key */
  cp_location_key: string;
  /** CP locations.id (uuid) */
  cp_location_id: string;
}

/**
 * Load every CP-wired location (both cp columns set), ordered by
 * location_code for stable run logs. Unwired stores are skipped — visible
 * in `locations`, never a silent hardcoded absence.
 */
export async function loadCpSyncLocations(
  supabase: AdminClient
): Promise<CpSyncLocation[]> {
  const { data, error } = await supabase
    .from("locations")
    .select("id, name, location_code, timezone, cp_location_key, cp_location_id")
    .not("cp_location_id", "is", null)
    .not("cp_location_key", "is", null)
    .order("location_code");
  if (error) throw new Error(`Failed to load CP crosswalk: ${error.message}`);

  return (data ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    location_code: r.location_code as string,
    timezone: (r.timezone as string | null) ?? null,
    cp_location_key: r.cp_location_key as string,
    cp_location_id: r.cp_location_id as string,
  }));
}
