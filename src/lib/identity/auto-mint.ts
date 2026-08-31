/**
 * Nightly auto-mint: give an EPD employee_code to people CP is already
 * scheduling, without a human in the loop (2026-08-31 identity packet §3).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE RULE: the identity key is (seven_shifts_user_id, location_id).
 * NEVER seven_shifts_user_id alone.
 * ─────────────────────────────────────────────────────────────────────────
 * EPD runs an INTENTIONAL per-store identity model: one person holds one code
 * PER STORE. Twelve people live hold 2–3 codes each (Milena Trevino has three
 * — FCOL/HRANCH/FCCSU; Taylor Garrison holds EMP-100100 at FCOL and EMP-100225
 * at FCCSU, where she is GM). A guard keyed on the 7shifts id alone would
 * block every multi-store employee and break the CSU scale-out. A person
 * appearing at a NEW store SHOULD get a NEW code — that is not a duplicate.
 *
 * WHY THIS REUSES THE TRIAGE POOL RATHER THAN RE-DERIVING THE CANDIDATE SET.
 * The packet specced the candidate scan from scratch, but the manual
 * triage-and-mint UI (kickoff-employee-triage-mint-ui-2026-08-21.md) already
 * implements the identical decision with the identical key, the identical
 * 0-phantom guard, and the identical never-match-on-name rule. So auto-mint
 * calls loadAutoMintPool(), which delegates to the SAME
 * fetchPendingDetections() the triage page renders. A person this job mints is
 * exactly a person who would have appeared as a triage card, and the automated
 * and human paths cannot drift apart. Re-implementing the scan would have
 * created a second writer with its own opinion of who exists — the failure
 * class this codebase has paid for repeatedly.
 *
 * WHAT STAYS HUMAN, ALWAYS — never auto-resolved:
 *   • archived matches (report only; never mint, never auto-reactivate)
 *   • blast-radius trips
 *   • unmappable CP locations (skip + escalate; NEVER guess a mapping)
 *   • epd_role classification — NEVER derived from a 7shifts role string
 *     ('MOD' covers a GM and three shift leads). New rows keep the DB
 *     default 'unclassified'.
 *   • GM designation
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchPendingDetections,
  normalizeSevenShiftsUserId,
} from "../triage/detections.ts";
import { loadCpSyncLocations } from "../ingest/culture-pulse/crosswalk.ts";

/**
 * Blast-radius cap, approved by Tucker 2026-08-31. More than this many mint
 * candidates in ONE run and the job mints NOTHING and escalates.
 *
 * This is the single control that makes an unattended write safe. A normal
 * night is 0–2 candidates (live dry run 2026-08-31: exactly 1). Double digits
 * means something upstream changed shape — a new store opened, the crosswalk
 * moved, CP backfilled a directory — and those are all cases where minting
 * dozens of codes unattended is far worse than minting none and waiting.
 */
export const BLAST_RADIUS_CAP = 10;

export interface AutoMintCandidate {
  cpId: string;
  sevenShiftsUserId: number;
  name: string;
  email: string | null;
  locationId: string;
  locationCode: string;
  locationName: string;
  /** CP's own location uuid for this store — the audit log records BOTH sides. */
  cpLocationId: string;
  /** Other stores already holding this 7shifts id — expected, not a warning. */
  alsoAtCodes: string[];
  triggerRow: Record<string, unknown>;
}

export interface ArchivedMatch {
  sevenShiftsUserId: number;
  locationId: string;
  locationCode: string;
  employeeCode: string;
  employeeName: string;
  archivedAt: string | null;
  acknowledged: boolean;
}

export interface UnmappableRow {
  cpId: string;
  sevenShiftsUserId: number | null;
  name: string;
  cpLocationId: string | null;
}

export interface AutoMintPool {
  candidates: AutoMintCandidate[];
  archived: ArchivedMatch[];
  unmappable: UnmappableRow[];
  /** Rows rejected by the id guard (null/0 — CP's open-shift convention). */
  guardRejected: number;
}

export interface AutoMintResult {
  started_at: string;
  finished_at: string;
  minted: Array<{ employee_code: string; name: string; location_code: string }>;
  /** Set when the cap tripped: nothing was minted. */
  blast_radius_tripped: boolean;
  candidates_seen: number;
  archived_new: ArchivedMatch[];
  archived_acknowledged: number;
  unmappable: UnmappableRow[];
  guard_rejected: number;
  errors: string[];
}

/**
 * Classify every pending detection into mint / archived / unmappable.
 *
 * Note the ORDER of the guards below is load-bearing: the id guard runs before
 * the location lookup so that a null/0 id is never reported as an unmappable
 * location, and the archived check runs before the mint decision so an
 * archived person can never fall through into a mint.
 */
export async function loadAutoMintPool(
  cp: SupabaseClient,
  epd: SupabaseClient
): Promise<AutoMintPool> {
  const pending = await fetchPendingDetections(cp, epd);
  const cpLocations = await loadCpSyncLocations(epd);
  // Reverse map: the pending pool exposes the EPD location it resolved to, so
  // recover CP's side from the same crosswalk rather than re-reading CP.
  const cpIdByEpdId = new Map(cpLocations.map((l) => [l.id, l.cp_location_id]));

  const candidates: AutoMintCandidate[] = [];
  const archived: ArchivedMatch[] = [];
  const unmappable: UnmappableRow[] = [];
  let guardRejected = 0;

  // Archived rows do NOT appear in `pending` — the triage exclusion set is
  // built from employees with no active filter, so an archived pair reads as
  // "already minted" there. The archived-match report is therefore a separate
  // read, not a partition of the pending pool.
  const archivedByPair = await loadArchivedScheduledPairs(cp, epd);
  archived.push(...archivedByPair);

  for (const d of pending) {
    // Guard 1: CP sends 0 for OPEN SHIFTS. CP minted a phantom "7shifts user
    // 0" contact this way before its PR #4 guarded it. 0 is representable so
    // it stays dismissable in the UI, but it is never mintable here.
    if (d.sevenShiftsUserId === null || d.sevenShiftsUserId <= 0) {
      guardRejected += 1;
      continue;
    }
    // Guard 2: no crosswalked EPD location => skip and escalate. Never guess.
    if (!d.location) {
      unmappable.push({
        cpId: d.cpId,
        sevenShiftsUserId: d.sevenShiftsUserId,
        name: d.name,
        cpLocationId: null,
      });
      continue;
    }
    candidates.push({
      cpId: d.cpId,
      sevenShiftsUserId: d.sevenShiftsUserId,
      name: d.name,
      email: d.email,
      locationId: d.location.id,
      locationCode: d.location.locationCode,
      locationName: d.location.name,
      cpLocationId: cpIdByEpdId.get(d.location.id) ?? "",
      alsoAtCodes: d.mintedElsewhere
        .map((m) => m.employeeCode)
        .filter((c): c is string => c !== null),
      triggerRow: {
        cp_id: d.cpId,
        sevenshifts_user_id: d.sevenShiftsUserId,
        employee_name: d.name,
        email: d.email,
        first_seen_at: d.firstSeenAt,
        last_seen_in_schedule_at: d.lastSeenAt,
      },
    });
  }

  return { candidates, archived, unmappable, guardRejected };
}

/**
 * Pairs that are ACTIVELY SCHEDULED in CP but whose EPD employee row is
 * archived. Never mintable, never auto-reactivated — reported for a human,
 * minus anything already acknowledged in identity_archived_schedule_ack.
 *
 * Live on 2026-08-31 this was ELEVEN pairs, not one: mostly the 2026-08-26
 * archive cleanup meeting CP's no-delete-path schedule accumulation. The
 * acknowledgement table exists so those eleven are triaged once instead of
 * alerting every night forever.
 */
async function loadArchivedScheduledPairs(
  cp: SupabaseClient,
  epd: SupabaseClient
): Promise<ArchivedMatch[]> {
  const cpLocations = await loadCpSyncLocations(epd);
  const epdIdByCpId = new Map(cpLocations.map((l) => [l.cp_location_id, l.id]));
  const codeByEpdId = new Map(cpLocations.map((l) => [l.id, l.location_code]));

  // Distinct (7shifts id, CP location) still on the schedule in the trailing
  // window. A person off the schedule entirely is not a live discrepancy.
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - ARCHIVED_LOOKBACK_DAYS);
  const { data: sched, error: schedError } = await cp
    .from("weekly_schedule_entries")
    .select("sevenshifts_user_id, location_id")
    .gte("target_monday", since.toISOString().slice(0, 10))
    .not("sevenshifts_user_id", "is", null);
  if (schedError)
    throw new Error(`CP weekly_schedule_entries: ${schedError.message}`);

  const scheduledPairs = new Set<string>();
  for (const r of (sched ?? []) as Array<{
    sevenshifts_user_id: string | null;
    location_id: string;
  }>) {
    const n = normalizeSevenShiftsUserId(r.sevenshifts_user_id);
    if (n === null || n <= 0) continue;
    const epdId = epdIdByCpId.get(r.location_id);
    if (!epdId) continue;
    scheduledPairs.add(`${n}|${epdId}`);
  }
  if (scheduledPairs.size === 0) return [];

  const { data: inactive, error: inactiveError } = await epd
    .from("employees")
    .select("employee_code, employee_name, seven_shifts_user_id, location_id, archived_at")
    .eq("active", false)
    .not("seven_shifts_user_id", "is", null);
  if (inactiveError) throw new Error(`EPD employees: ${inactiveError.message}`);

  const { data: acks, error: ackError } = await epd
    .from("identity_archived_schedule_ack")
    .select("seven_shifts_user_id, location_id");
  if (ackError)
    throw new Error(`EPD identity_archived_schedule_ack: ${ackError.message}`);
  const acked = new Set(
    ((acks ?? []) as Array<{ seven_shifts_user_id: number; location_id: string }>).map(
      (a) => `${a.seven_shifts_user_id}|${a.location_id}`
    )
  );

  const out: ArchivedMatch[] = [];
  for (const e of (inactive ?? []) as Array<{
    employee_code: string;
    employee_name: string;
    seven_shifts_user_id: number;
    location_id: string;
    archived_at: string | null;
  }>) {
    const key = `${e.seven_shifts_user_id}|${e.location_id}`;
    if (!scheduledPairs.has(key)) continue;
    out.push({
      sevenShiftsUserId: e.seven_shifts_user_id,
      locationId: e.location_id,
      locationCode: codeByEpdId.get(e.location_id) ?? "?",
      employeeCode: e.employee_code,
      employeeName: e.employee_name,
      archivedAt: e.archived_at,
      acknowledged: acked.has(key),
    });
  }
  return out;
}

/** Trailing window for "still being scheduled". Matches the CP schedule sync's lookahead. */
const ARCHIVED_LOOKBACK_DAYS = 28;
