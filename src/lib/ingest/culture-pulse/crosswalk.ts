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
 * errored). FCCSU is still unwired, but NOT for the reason this comment
 * used to give. Verified live 2026-08-31: CP's `fort_collins_csu`
 * (id 90cd4cd4-4476-40e4-abab-5af79ef98312) is ACTIVE, with 11
 * employee_directory rows and 102 weekly_schedule_entries rows — the store
 * opened 2026-08-24 and every row is from then on. So the old premise
 * ("CP carries an INACTIVE fort_collins_csu") is false and must not be
 * relied on again.
 *
 * FCCSU stays unwired purely as a SCOPE decision: setting these two columns
 * is not a mapping edit, it onboards the store to every consumer of this
 * loader at once — the 09:45 survey ingest, the 09:40 schedule sync (whose
 * first run for a store backfills from SCHEDULE_BACKFILL_FLOOR into
 * time_entries rows (entry_type = 'scheduled') and recomputes those quarters),
 * triage detections, and the 7shifts probe. Onboarding FCCSU is its own PR
 * with its own verification (Tucker, 2026-08-31). For the record, the
 * backfill it implies is small and touches nothing frozen: 102 rows, all
 * 2026-08-24 or later, landing in Q3 2026 — the only frozen periods are
 * Q3 2025 and Q4 2025.
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
