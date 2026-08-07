/**
 * Shared location crosswalk codes (migration 027) — the single source for the
 * EPD->CP feed routes (/api/scores + /api/identity), which reject anything
 * else with 400. LOCATION_TIMEZONES (ingest/sevenshifts/tz.ts) is keyed by
 * the same codes.
 */
export const LOCATION_CODES = [
  "CPD",
  "COS",
  "DTD",
  "FCOL",
  "HRANCH",
  "HOU",
  "LONGM",
  "NOLA",
];
