/**
 * PURE core of the direct 7shifts scheduled-shift feed (§4-H): payload
 * classification + absence arithmetic, split from shifts.ts so the node
 * test runner can load it without the ingest I/O chain (the client.ts /
 * streak.ts pattern — only tz.ts, which is standalone, rides along). See
 * shifts.ts for the feed's full doctrine.
 */

import { utcToLocalWallClock, timezoneForLocationCode } from "./tz.ts";
import type { LocationCrosswalk } from "./crosswalk";

export interface RawShift {
  id: number;
  user_id: number | null;
  location_id: number;
  start: string | null;
  end: string | null;
  deleted?: boolean;
  draft?: boolean;
  open?: boolean;
  publish_status?: string | null;
  attendance_status?: string | null;
  late_minutes?: number | null;
  role_id?: number | null;
  [k: string]: unknown;
}

export interface ShiftUpsertRow {
  seven_shifts_shift_id: number;
  location_id: string;
  employee_id: string | null;
  seven_shifts_user_id: number;
  entry_date: string;
  start_at: string;
  end_at: string | null;
  deleted: boolean;
  draft: boolean;
  publish_status: string | null;
  attendance_status: string | null;
  late_minutes: number | null;
  missing_upstream_since: null;
  last_seen_upstream_at: string;
  raw: RawShift;
  role?: string | null;
}

export interface ShiftClassification {
  /** Upsert rows per EPD location id. */
  byLocation: Map<string, ShiftUpsertRow[]>;
  /** Shift ids seen per EPD location id — feeds absence-tombstoning. */
  seenIdsByLocation: Map<string, Set<number>>;
  skippedOpenOrUnassigned: number;
  skippedDraft: number;
  skippedDeleted: number;
  skippedOtherLocation: number;
  skippedNoStart: number;
  unmatchedUserIds: number[];
}

/**
 * Classify a company-wide pull into per-location upsert rows. Pure given the
 * employee maps — the §4-H7 unit-test surface. Skip rules (probe + addendum):
 * non-crosswalked location (the Chico class); deleted/draft flags (filtered
 * at read time); open/user-0/null-assignee (an open shift must never become
 * anyone's missed shift); unparseable start. A REAL user id with no roster
 * row at that site is stored with employee_id null, never dropped.
 */
export function classifyShifts(
  shifts: RawShift[],
  companyLocations: LocationCrosswalk[],
  userToEmployeeByLocation: Map<string, Map<number, string>>,
  nowIso: string,
  roleNames: Map<number, string> | null
): ShiftClassification {
  const locBySevenShiftsId = new Map(
    companyLocations.map((l) => [l.seven_shifts_location_id, l])
  );
  const byLocation = new Map<string, ShiftUpsertRow[]>();
  const seenIdsByLocation = new Map<string, Set<number>>();
  for (const l of companyLocations) {
    byLocation.set(l.id, []);
    seenIdsByLocation.set(l.id, new Set());
  }

  const unmatched = new Set<number>();
  const out: ShiftClassification = {
    byLocation,
    seenIdsByLocation,
    skippedOpenOrUnassigned: 0,
    skippedDraft: 0,
    skippedDeleted: 0,
    skippedOtherLocation: 0,
    skippedNoStart: 0,
    unmatchedUserIds: [],
  };

  for (const s of shifts) {
    const loc = locBySevenShiftsId.get(Number(s.location_id));
    if (!loc) {
      out.skippedOtherLocation += 1;
      continue;
    }
    if (s.deleted === true) {
      // Unexpected per the probe (deleted shifts vanish) — but if the API
      // ever starts flagging them, they must not enter as live schedule.
      out.skippedDeleted += 1;
      continue;
    }
    if (s.draft === true) {
      out.skippedDraft += 1;
      continue;
    }
    const userId = s.user_id == null ? 0 : Number(s.user_id);
    if (s.open === true || userId <= 0 || !Number.isSafeInteger(userId)) {
      out.skippedOpenOrUnassigned += 1;
      continue;
    }
    const tz = timezoneForLocationCode(loc.location_code);
    const local = utcToLocalWallClock(s.start, tz);
    if (!local || typeof s.id !== "number") {
      out.skippedNoStart += 1;
      continue;
    }

    const employeeId =
      userToEmployeeByLocation.get(loc.id)?.get(userId) ?? null;
    if (employeeId === null) unmatched.add(userId);

    const row: ShiftUpsertRow = {
      seven_shifts_shift_id: s.id,
      location_id: loc.id,
      employee_id: employeeId,
      seven_shifts_user_id: userId,
      entry_date: local.date,
      start_at: s.start as string,
      end_at: s.end ?? null,
      deleted: false,
      draft: false,
      publish_status: s.publish_status ?? null,
      attendance_status: s.attendance_status ?? null,
      late_minutes: s.late_minutes ?? null,
      missing_upstream_since: null,
      last_seen_upstream_at: nowIso,
      raw: s,
    };
    // Mirror time.ts's role discipline: when the role lookup failed, omit
    // the column so the upsert leaves any previously-stored name untouched.
    if (roleNames) {
      row.role =
        s.role_id != null ? (roleNames.get(Number(s.role_id)) ?? null) : null;
    }
    byLocation.get(loc.id)!.push(row);
    seenIdsByLocation.get(loc.id)!.add(s.id);
  }

  out.unmatchedUserIds = Array.from(unmatched);
  return out;
}

/** The absence arithmetic for the tombstone pass, pure for testing: which
 * stored ids does a complete pull no longer contain? */
export function missingIds(stored: number[], seen: Set<number>): number[] {
  return stored.filter((id) => !seen.has(id));
}
