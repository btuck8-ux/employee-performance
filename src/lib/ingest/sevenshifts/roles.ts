/**
 * 7shifts role lookup for the time ingest (handoff 2026-07-28 §3.1).
 *
 * GET /v2/company/{company_id}/roles -> [{ id, name, location_id, ... }].
 * The time-punch object carries role_id; resolving it to the role NAME here is
 * what restores `time_entries.role` (the nightly had hardcoded role: null since
 * mid-April, silently overwriting the CSV-era values on every upsert).
 *
 * Cached per company with a short TTL: roles change rarely, and the nightly
 * fans six CO stores out over one company_id — one fetch serves all six.
 */

import { getAll } from "./client";

interface SevenShiftsRole {
  id: number;
  name?: string | null;
}

const ROLE_CACHE_TTL_MS = 15 * 60 * 1000;

const cache = new Map<number, { at: number; map: Map<number, string> }>();

export async function rolesForCompany(companyId: number): Promise<Map<number, string>> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < ROLE_CACHE_TTL_MS) return hit.map;

  const roles = await getAll<SevenShiftsRole>(companyId, "roles", { limit: 100 });
  const map = new Map<number, string>();
  for (const r of roles) {
    const name = (r.name ?? "").trim();
    if (r.id != null && name) map.set(Number(r.id), name);
  }

  cache.set(companyId, { at: Date.now(), map });
  return map;
}
