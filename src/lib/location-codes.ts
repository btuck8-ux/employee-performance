import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Location codes, read from `public.locations` — the table OWNS this fact.
 *
 * THE RULE (Tucker, 2026-08-26, adopting THQ's formulation): DO NOT KEEP A
 * COPY OF ANYTHING THE DATABASE OWNS. The previous hand-maintained array
 * here is exactly how FCCSU 400'd on /api/scores and /api/identity and
 * silently vanished from an unfiltered /api/scores/range: the store existed
 * in `locations` and not in the copy. Adding the new code to the array
 * would have reproduced the defect one location later.
 *
 * Validation semantics are unchanged: an unknown code still 400s at the
 * feed routes. Every consumer is force-dynamic, so a per-request read is
 * cheap; the short TTL below only smooths bursts (staleness ceiling: a
 * brand-new store is queryable within a minute, which is faster than any
 * ingest can populate it).
 *
 * A structural sweep test (location-literals-sweep.test.ts) fails the build
 * if a hardcoded location literal reappears anywhere in src/.
 */

const TTL_MS = 60_000;
let cache: { codes: string[]; fetchedAt: number } | null = null;

/** The live location_code set, ordered — same shape the old const carried. */
export async function getLocationCodes(): Promise<string[]> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.codes;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("locations")
    .select("location_code")
    .order("location_code");
  if (error) throw new Error(`location codes read: ${error.message}`);
  const codes = (data ?? []).map((r) => String(r.location_code));
  if (codes.length === 0) {
    // Zero rows is a broken read (locations is never empty), not an empty
    // estate — caching it would 400 every filtered feed call for the TTL.
    throw new Error("location codes read returned zero rows — refusing to cache");
  }
  cache = { codes, fetchedAt: Date.now() };
  return codes;
}

export async function isKnownLocationCode(code: string): Promise<boolean> {
  return (await getLocationCodes()).includes(code);
}

/**
 * Store floors for the feed envelopes (THQ wire item 3, packet 5 §7.3):
 * location_code -> metrics_start_date (data_start_date on the wire). A
 * floor is a property of a STORE — putting it only on rows means every
 * Houston employee carries an identical copy of a fact Houston owns, and a
 * store-scoped envelope field survives a zero-row response. `codes` scopes
 * to the request's stores; omitted/empty = the whole estate.
 *
 * THQ DECLINED a second envelope field for correction coverage — Houston's
 * 32-day blend and NOLA-being-CAKE live in the contract note, not on the
 * wire. Do not add envelope fields here without the same cross-project
 * coordination as the row shape.
 */
export async function fetchLocationFloors(
  codes?: string[]
): Promise<Record<string, string | null>> {
  const supabase = createAdminClient();
  let q = supabase.from("locations").select("location_code, metrics_start_date");
  if (codes && codes.length > 0) q = q.in("location_code", codes);
  const { data, error } = await q.order("location_code");
  if (error) throw new Error(`location floors read: ${error.message}`);
  const out: Record<string, string | null> = {};
  for (const r of data ?? []) {
    out[String(r.location_code)] = (r.metrics_start_date as string | null) ?? null;
  }
  return out;
}

/** Test hook: drop the cache so a test can observe a fresh read. */
export function __clearLocationCodesCache(): void {
  cache = null;
}
