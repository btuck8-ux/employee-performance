/**
 * Detected-employee triage: CP's schedule-feed detections with no EPD roster
 * row yet (kickoff-employee-triage-mint-ui-2026-08-21.md §3a).
 *
 * Source is CP's `employee_directory` (READ-ONLY via createCpClient(), the
 * third CP direct read after the survey and schedule feeds — same interim-
 * credential shape and change-notice contract). The detection pool is rows
 * with source='discovered_from_schedule' and no CP-side employee_code;
 * anyone whose (7shifts user id, site) pair already exists on the EPD roster
 * (minted) or in detection_dismissals (operator-dismissed, mig 053) drops
 * off — which is also what keeps the five 2026-08-21 stopgap mints
 * (EMP-100220–100224) off the page from day one.
 *
 * EXCLUSION IS KEYED ON (seven_shifts_user_id, location_id), NOT the id
 * alone (2026-08-23 multi-location sprint §4-A): one person working two
 * sites is two `employees` rows by design (six live pairs, e.g. Liv
 * Sandifer 10418605 at HRANCH + LONGM), so a person already rostered at
 * site A must still surface as a detection at site B. The CP side of the
 * pair is mapped to EPD through the location crosswalk; a detection whose
 * CP site isn't crosswalked has no derivable pair and stays visible (its
 * mint is blocked by the crosswalk warning — the fix is upstream).
 *
 * MATCHING KEYS ON THE 7SHIFTS USER ID, NEVER ON NAME (live near-misses that
 * burned a triage pass: Ryan Griffin 8585453 ≠ Connor Griffin; Amy Roberts
 * 11313462 ≠ Amy Segelhorst). findSimilarRosterNames() below is UI caution
 * copy only — it never gates, matches, or excludes.
 *
 * CP-side `sevenshifts_user_id` is TEXT (verified live 2026-08-21); EPD's
 * employees.seven_shifts_user_id is bigint — normalizeSevenShiftsUserId() is
 * the single text→number bridge. 0 is the known "7shifts user 0" phantom
 * class: representable (dismissable) but never mintable.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadCpSyncLocations,
  type CpSyncLocation,
} from "../ingest/culture-pulse/crosswalk.ts";

/** The columns the triage read pulls from CP employee_directory. */
export interface CpDetectionRow {
  id: string;
  location_id: string;
  employee_name: string;
  email: string | null;
  phone: string | null;
  sevenshifts_user_id: string | null;
  first_seen_at: string;
  last_seen_in_schedule_at: string | null;
}

export interface SimilarRosterName {
  employee_code: string;
  employee_name: string;
}

/** A site where the detection's 7shifts id is already minted (another store). */
export interface MintedElsewhere {
  locationName: string;
  employeeCode: string | null;
}

/** One reviewable detection, ready for the triage card. */
export interface PendingDetection {
  cpId: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** Parsed 7shifts user id; null = unparseable (unmintable AND undismissable). */
  sevenShiftsUserId: number | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
  /** EPD location via the CP crosswalk; null = CP location not in the map. */
  location: { id: string; name: string; locationCode: string } | null;
  similar: SimilarRosterName[];
  /**
   * Other EPD sites already holding this 7shifts id (§4-A4): confirming this
   * card mints a SECOND, location-scoped code — the operator must see that.
   */
  mintedElsewhere: MintedElsewhere[];
}

/**
 * CP stores the 7shifts user id as text — parse to a non-negative integer or
 * null. 0 parses (the phantom class must stay addressable for dismissal);
 * mintability (> 0) is the caller's stricter check.
 */
export function normalizeSevenShiftsUserId(
  raw: string | null | undefined
): number | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

export interface RosterNameRow {
  employee_code: string;
  employee_name: string;
  location_id: string;
}

const SIMILAR_CAP = 3;

/**
 * Same-location roster entries whose name could be confused with the
 * detection's: exact full-name match or shared surname (last whitespace
 * token, ≥2 chars). Purely informational — the caution copy on the card.
 * Deliberately NOT shared-first-name (an "Amy" hint on every card is noise);
 * the Amy Roberts ≠ Amy Segelhorst class is protected by id-keyed matching,
 * not by this hint.
 */
export function findSimilarRosterNames(
  detectionName: string,
  locationId: string | null,
  roster: RosterNameRow[]
): SimilarRosterName[] {
  if (!locationId) return [];
  const name = detectionName.trim().toLowerCase();
  if (!name) return [];
  const tokens = name.split(/\s+/);
  const surname = tokens.length > 1 ? tokens[tokens.length - 1] : null;
  const out: SimilarRosterName[] = [];
  for (const r of roster) {
    if (r.location_id !== locationId) continue;
    const other = r.employee_name.trim().toLowerCase();
    if (!other) continue;
    const otherTokens = other.split(/\s+/);
    const otherSurname =
      otherTokens.length > 1 ? otherTokens[otherTokens.length - 1] : null;
    const exact = other === name;
    const sharedSurname =
      surname !== null &&
      surname.length >= 2 &&
      otherSurname !== null &&
      otherSurname === surname;
    if (exact || sharedSurname) {
      out.push({
        employee_code: r.employee_code,
        employee_name: r.employee_name,
      });
      if (out.length >= SIMILAR_CAP) break;
    }
  }
  return out;
}

/** A minted-roster or dismissal row carrying the (7s id, EPD site) pair. */
export interface IdentityPairRow {
  seven_shifts_user_id: number | string | null;
  location_id: string;
}

/** The pair key the exclusion set is built on. EPD location uuid, not CP's. */
function pairKey(ssid: number, epdLocationId: string): string {
  return `${ssid}|${epdLocationId}`;
}

/**
 * Build the exclusion set from minted-roster + dismissal rows: one
 * "ssid|epdLocationId" key per pair. Rows with an unusable id contribute
 * nothing (they cannot collide with a parsed detection id).
 */
export function buildExclusionPairs(rows: IdentityPairRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    // Strict per type: Number(null) and Number("") are 0, which would
    // silently collide with the phantom class — never coerce loosely here.
    const n =
      typeof r.seven_shifts_user_id === "string"
        ? normalizeSevenShiftsUserId(r.seven_shifts_user_id)
        : r.seven_shifts_user_id;
    if (n !== null && Number.isSafeInteger(n) && r.location_id) {
      out.add(pairKey(n, r.location_id));
    }
  }
  return out;
}

/**
 * The §4-A exclusion rule, pure and pinned by test: a detection drops only
 * when its (7s id, site) pair is already minted or dismissed AT THAT SITE.
 * Unparseable ids and un-crosswalked CP sites stay visible.
 */
export function isDetectionExcluded(
  ssid: number | null,
  cpLocationId: string,
  epdLocationIdByCpLocationId: Map<string, string>,
  excludedPairs: Set<string>
): boolean {
  if (ssid === null) return false;
  const epdLocationId = epdLocationIdByCpLocationId.get(cpLocationId);
  if (!epdLocationId) return false;
  return excludedPairs.has(pairKey(ssid, epdLocationId));
}

interface MintedIdentityRow extends IdentityPairRow {
  employee_code: string | null;
}

interface PendingPool {
  rows: CpDetectionRow[];
  cpLocations: CpSyncLocation[];
  minted: MintedIdentityRow[];
}

/**
 * The shared pool query: CP detections still pending after the EPD-side
 * pair-keyed exclusions. Throws on any read error (fail loud, house
 * convention).
 */
async function loadPendingPool(
  cp: SupabaseClient,
  epd: SupabaseClient
): Promise<PendingPool> {
  const { data: cpRows, error: cpError } = await cp
    .from("employee_directory")
    .select(
      "id, location_id, employee_name, email, phone, sevenshifts_user_id, first_seen_at, last_seen_in_schedule_at"
    )
    .eq("source", "discovered_from_schedule")
    .is("employee_code", null)
    .order("first_seen_at", { ascending: true });
  if (cpError) throw new Error(`CP employee_directory: ${cpError.message}`);

  // Exclusion sets are keyed on the (7shifts user id, location) pair — the
  // id is the only identity matching is allowed to use, and the site scopes
  // it (§4-A: multi-site people are separate rows per store by design).
  const { data: minted, error: mintedError } = await epd
    .from("employees")
    .select("seven_shifts_user_id, location_id, employee_code")
    .not("seven_shifts_user_id", "is", null);
  if (mintedError) throw new Error(`EPD employees: ${mintedError.message}`);

  const { data: dismissed, error: dismissedError } = await epd
    .from("detection_dismissals")
    .select("seven_shifts_user_id, location_id");
  if (dismissedError)
    throw new Error(`EPD detection_dismissals: ${dismissedError.message}`);

  const cpLocations = await loadCpSyncLocations(epd);
  const epdIdByCpId = new Map(
    cpLocations.map((l) => [l.cp_location_id, l.id])
  );

  const mintedRows = (minted ?? []) as MintedIdentityRow[];
  const excluded = buildExclusionPairs([
    ...mintedRows,
    ...((dismissed ?? []) as IdentityPairRow[]),
  ]);

  const rows = ((cpRows ?? []) as CpDetectionRow[]).filter(
    (row) =>
      !isDetectionExcluded(
        normalizeSevenShiftsUserId(row.sevenshifts_user_id),
        row.location_id,
        epdIdByCpId,
        excluded
      )
  );

  return { rows, cpLocations, minted: mintedRows };
}

/** Pending-detection count for the Employees-page chip. */
export async function countPendingDetections(
  cp: SupabaseClient,
  epd: SupabaseClient
): Promise<number> {
  return (await loadPendingPool(cp, epd)).rows.length;
}

/**
 * Re-derive the mint site server-side at confirm time (Codex finding 2,
 * 2026-08-21): the location is crosswalk-derived, never client input — a
 * stale or tampered form must not pick the store. Looks up the still-pending
 * CP detection by its 7shifts user id and maps its CP location to EPD; null
 * = detection gone (already coded CP-side) or its CP location isn't in the
 * crosswalk. (CP today holds at most one pending row per user id — its
 * ingest matcher is globally id-keyed. If CP ships per-site directory rows,
 * this limit(1) becomes ambiguous and needs the CP row id as a second key.)
 */
export async function resolveDetectionLocation(
  cp: SupabaseClient,
  epd: SupabaseClient,
  sevenShiftsUserId: number
): Promise<{ id: string; name: string } | null> {
  const { data, error } = await cp
    .from("employee_directory")
    .select("location_id")
    .eq("source", "discovered_from_schedule")
    .eq("sevenshifts_user_id", String(sevenShiftsUserId))
    .is("employee_code", null)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`CP employee_directory: ${error.message}`);
  if (!data) return null;
  const cpLocations = await loadCpSyncLocations(epd);
  const loc = cpLocations.find((l) => l.cp_location_id === data.location_id);
  return loc ? { id: loc.id, name: loc.name } : null;
}

/** Full triage-page payload: pool rows + crosswalk + similar-name hints. */
export async function fetchPendingDetections(
  cp: SupabaseClient,
  epd: SupabaseClient
): Promise<PendingDetection[]> {
  const { rows, cpLocations, minted } = await loadPendingPool(cp, epd);
  if (rows.length === 0) return [];

  const byCpLocationId = new Map<string, CpSyncLocation>(
    cpLocations.map((l) => [l.cp_location_id, l])
  );
  const nameByEpdLocationId = new Map<string, string>(
    cpLocations.map((l) => [l.id, l.name])
  );

  // Sites already holding each 7shifts id — feeds the §4-A4 "already on the
  // roster at X" card notice for second-site mints.
  const mintedBySsid = new Map<number, MintedIdentityRow[]>();
  for (const m of minted) {
    const n = Number(m.seven_shifts_user_id);
    if (!Number.isSafeInteger(n)) continue;
    const list = mintedBySsid.get(n) ?? [];
    list.push(m);
    mintedBySsid.set(n, list);
  }

  const { data: rosterData, error: rosterError } = await epd
    .from("employees")
    .select("employee_code, employee_name, location_id");
  if (rosterError) throw new Error(`EPD roster names: ${rosterError.message}`);
  const roster = (rosterData ?? []) as RosterNameRow[];

  return rows.map((row) => {
    const loc = byCpLocationId.get(row.location_id) ?? null;
    const ssid = normalizeSevenShiftsUserId(row.sevenshifts_user_id);
    const mintedElsewhere: MintedElsewhere[] =
      ssid === null
        ? []
        : (mintedBySsid.get(ssid) ?? [])
            .filter((m) => m.location_id !== loc?.id)
            .map((m) => ({
              locationName:
                nameByEpdLocationId.get(m.location_id) ?? "another site",
              employeeCode: m.employee_code,
            }));
    return {
      cpId: row.id,
      name: row.employee_name,
      email: row.email,
      phone: row.phone,
      sevenShiftsUserId: ssid,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_in_schedule_at,
      location: loc
        ? { id: loc.id, name: loc.name, locationCode: loc.location_code }
        : null,
      similar: findSimilarRosterNames(
        row.employee_name,
        loc?.id ?? null,
        roster
      ),
      mintedElsewhere,
    };
  });
}
