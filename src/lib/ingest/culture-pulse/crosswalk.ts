/**
 * CP↔EPD location crosswalk for the survey feed.
 *
 * CP (Supabase pkjugezverggrcmfylkf) and EPD share no location id, so the CP
 * side is a hardcoded 8-row map (mirrors the 7shifts-company-id treatment;
 * verified live 2026-07-26, handoff-cp-survey-feed-EXECUTE-2026-07-26.md §4a).
 * The EPD side is looked up live by location_code so this file never carries
 * EPD UUIDs that the database already owns.
 *
 * CP also has an inactive `fort_collins_csu` location — deliberately absent
 * here (not an EPD store). NOLA is in-scope for surveys (CP sends there);
 * its other EPD categories stay NULL by design.
 */

import type { AdminClient } from "../sevenshifts/crosswalk";

export interface CpLocationMap {
  /** CP locations.location_key */
  cp_location_key: string;
  /** CP locations.id (uuid) */
  cp_location_id: string;
  /** EPD locations.location_code */
  location_code: string;
}

export const CP_LOCATION_MAP: CpLocationMap[] = [
  { cp_location_key: "central_park", cp_location_id: "5331d029-cf4a-492b-8c58-9baa3578b5e4", location_code: "CPD" },
  { cp_location_key: "colorado_springs", cp_location_id: "bcd5a8a6-62db-452c-9aee-a3930bf4030b", location_code: "COS" },
  { cp_location_key: "downtown_denver", cp_location_id: "4c9a20f7-b306-4fa6-b680-8834dbe87e9f", location_code: "DTD" },
  { cp_location_key: "fort_collins", cp_location_id: "d0c95fee-1c69-463c-b08a-6720be0a78f9", location_code: "FCOL" },
  { cp_location_key: "highlands_ranch", cp_location_id: "93886ea2-c35f-4eec-8421-aeab07892c53", location_code: "HRANCH" },
  { cp_location_key: "longmont", cp_location_id: "2d349e4d-b0af-4041-a35f-fcc4ee65959e", location_code: "LONGM" },
  { cp_location_key: "houston", cp_location_id: "653085db-7e8c-483a-aa20-615179015fe2", location_code: "HOU" },
  { cp_location_key: "new_orleans", cp_location_id: "8f7906ff-63b5-4a70-bd12-66e5a7456d50", location_code: "NOLA" },
];

/** One synced location: the CP map row joined to its live EPD row. */
export interface CpSyncLocation extends CpLocationMap {
  /** EPD locations.id */
  id: string;
  name: string;
}

/**
 * Join the hardcoded CP map to EPD's locations table. Throws if an expected
 * location_code is missing on the EPD side (a config bug, not a skippable
 * condition — all 8 stores are surveyed).
 */
export async function loadCpSyncLocations(
  supabase: AdminClient
): Promise<CpSyncLocation[]> {
  const { data, error } = await supabase
    .from("locations")
    .select("id, name, location_code");
  if (error) throw new Error(`Failed to load EPD locations: ${error.message}`);

  const byCode = new Map(
    (data ?? []).map((r) => [r.location_code as string, r])
  );
  return CP_LOCATION_MAP.map((m) => {
    const epd = byCode.get(m.location_code);
    if (!epd) {
      throw new Error(`EPD location_code ${m.location_code} not found for CP ${m.cp_location_key}`);
    }
    return { ...m, id: epd.id as string, name: epd.name as string };
  }).sort((a, b) => a.location_code.localeCompare(b.location_code));
}
