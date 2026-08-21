/**
 * Detected-employee triage: CP's schedule-feed detections with no EPD roster
 * row yet (kickoff-employee-triage-mint-ui-2026-08-21.md §3a).
 *
 * Source is CP's `employee_directory` (READ-ONLY via createCpClient(), the
 * third CP direct read after the survey and schedule feeds — same interim-
 * credential shape and change-notice contract). The detection pool is rows
 * with source='discovered_from_schedule' and no CP-side employee_code;
 * anyone whose 7shifts user id already exists on the EPD roster (minted) or
 * in detection_dismissals (operator-dismissed, mig 052) drops off — which is
 * also what keeps the five 2026-08-21 stopgap mints (EMP-100220–100224) off
 * the page from day one.
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

/**
 * The shared pool query: CP detections still pending after the EPD-side
 * exclusions. Throws on any read error (fail loud, house convention).
 */
async function loadPendingRows(
  cp: SupabaseClient,
  epd: SupabaseClient
): Promise<CpDetectionRow[]> {
  const { data: cpRows, error: cpError } = await cp
    .from("employee_directory")
    .select(
      "id, location_id, employee_name, email, phone, sevenshifts_user_id, first_seen_at, last_seen_in_schedule_at"
    )
    .eq("source", "discovered_from_schedule")
    .is("employee_code", null)
    .order("first_seen_at", { ascending: true });
  if (cpError) throw new Error(`CP employee_directory: ${cpError.message}`);

  // Exclusion sets are keyed on the 7shifts user id — the only identity the
  // matching is allowed to use.
  const { data: minted, error: mintedError } = await epd
    .from("employees")
    .select("seven_shifts_user_id")
    .not("seven_shifts_user_id", "is", null);
  if (mintedError) throw new Error(`EPD employees: ${mintedError.message}`);

  const { data: dismissed, error: dismissedError } = await epd
    .from("detection_dismissals")
    .select("seven_shifts_user_id");
  if (dismissedError)
    throw new Error(`EPD detection_dismissals: ${dismissedError.message}`);

  const known = new Set<number>();
  for (const r of minted ?? []) {
    const n = Number(r.seven_shifts_user_id);
    if (Number.isSafeInteger(n)) known.add(n);
  }
  for (const r of dismissed ?? []) {
    const n = Number(r.seven_shifts_user_id);
    if (Number.isSafeInteger(n)) known.add(n);
  }

  return ((cpRows ?? []) as CpDetectionRow[]).filter((row) => {
    const ssid = normalizeSevenShiftsUserId(row.sevenshifts_user_id);
    // Unparseable ids stay visible (a real person the admin should see —
    // just unmintable until CP carries a usable id).
    return ssid === null || !known.has(ssid);
  });
}

/** Pending-detection count for the Employees-page chip. */
export async function countPendingDetections(
  cp: SupabaseClient,
  epd: SupabaseClient
): Promise<number> {
  return (await loadPendingRows(cp, epd)).length;
}

/** Full triage-page payload: pool rows + crosswalk + similar-name hints. */
export async function fetchPendingDetections(
  cp: SupabaseClient,
  epd: SupabaseClient
): Promise<PendingDetection[]> {
  const rows = await loadPendingRows(cp, epd);
  if (rows.length === 0) return [];

  const cpLocations = await loadCpSyncLocations(epd);
  const byCpLocationId = new Map<string, CpSyncLocation>(
    cpLocations.map((l) => [l.cp_location_id, l])
  );

  const { data: rosterData, error: rosterError } = await epd
    .from("employees")
    .select("employee_code, employee_name, location_id");
  if (rosterError) throw new Error(`EPD roster names: ${rosterError.message}`);
  const roster = (rosterData ?? []) as RosterNameRow[];

  return rows.map((row) => {
    const loc = byCpLocationId.get(row.location_id) ?? null;
    return {
      cpId: row.id,
      name: row.employee_name,
      email: row.email,
      phone: row.phone,
      sevenShiftsUserId: normalizeSevenShiftsUserId(row.sevenshifts_user_id),
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
    };
  });
}
