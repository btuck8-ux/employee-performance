/**
 * CP scheduled shifts → EPD `time_entries` (entry_type 'scheduled'): the pure
 * resolve + collapse layer (kickoff-ui-rbac-c-brand-2026-08-14.md §3).
 *
 * SCHEDULE ONLY (hard fence, the mirror of sevenshifts/time.ts's actuals-only
 * fence): this path emits `entry_type='scheduled'` rows and nothing else —
 * pinned by schedule-resolve.test.ts. Worked actuals keep their existing
 * sources (7shifts / CAKE).
 *
 * Row shape mirrors the CSV-era scheduled importer exactly
 * (time-entries-import.ts + upload-time-actions.ts), because
 * performance-recompute.ts's attendance / on-time math (3-minute grace on
 * in_time) was built against those rows:
 *   - grain: one row per (employee, local entry_date, 'scheduled') — the
 *     time_entries unique constraint;
 *   - multi-shift days collapse to earliest-in / latest-out with per-shift
 *     durations SUMMED into regular_hours;
 *   - entry_date is the store-LOCAL date of the shift START (overnight shifts
 *     keep the start date; out_time may read "earlier" than in_time, same as
 *     a CSV row would);
 *   - wage stays null and pay columns stay 0 (the CSV parser's defaults) —
 *     scheduling carries no pay facts.
 *
 * Employee resolution: employee_code primary (EPD mints codes; CP carries
 * them on ~99% of schedule rows), sevenshifts_user_id fallback
 * (employees.seven_shifts_user_id is unique per location), unmatched → skip
 * and surface in the run detail. NEVER mint identities from this feed — the
 * ~1–2% uncoded rows are the known CP-side residual classes (triage there).
 */

import { utcToLocalWallClock } from "../sevenshifts/tz.ts";

/** One CP weekly_schedule_entries row (the columns this feed reads). */
export interface CpScheduleRow {
  id: string;
  employee_name: string | null;
  employee_email: string | null;
  shift_start_at: string | null;
  shift_end_at: string | null;
  role: string | null;
  employee_code: string | null;
  sevenshifts_user_id: number | string | null;
}

/** EPD employees roster slice used for resolution. */
export interface ScheduleRosterEmployee {
  id: string;
  employee_name: string;
  employee_code: string | null;
  seven_shifts_user_id: number | null;
  active: boolean;
}

export interface ScheduleRosterIndex {
  byCode: Map<string, ScheduleRosterEmployee>;
  bySevenShiftsId: Map<number, ScheduleRosterEmployee>;
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function buildScheduleRosterIndex(
  roster: ScheduleRosterEmployee[]
): ScheduleRosterIndex {
  const byCode = new Map<string, ScheduleRosterEmployee>();
  const bySevenShiftsId = new Map<number, ScheduleRosterEmployee>();
  for (const e of roster) {
    if (e.employee_code) byCode.set(normalizeCode(e.employee_code), e);
    if (e.seven_shifts_user_id != null) {
      bySevenShiftsId.set(Number(e.seven_shifts_user_id), e);
    }
  }
  return { byCode, bySevenShiftsId };
}

/** One collapsed (employee, local date) scheduled shift. */
export interface CollapsedScheduledShift {
  employee_id: string;
  entry_date: string; // YYYY-MM-DD, local date of the earliest shift start
  in_time: string; // HH:MM:SS local, earliest start
  out_time: string | null; // HH:MM:SS local, latest end (CSV string-compare rule)
  hours: number; // summed per-shift durations
  role: string | null; // role of the earliest-starting shift that carried one
  shift_count: number;
}

export interface ScheduleCollapseOutcome {
  entries: CollapsedScheduledShift[];
  resolved_by_code: number;
  resolved_by_seven_shifts_id: number;
  /** Deduped display labels for CP rows that matched no EPD employee. */
  unmatched: string[];
  /** Deduped display labels for rows resolving to inactive employees. */
  inactive_skipped: string[];
  skipped_no_start: number;
  /** Days where one person had more than one CP shift (merged per CSV rule). */
  multi_shift_days: number;
}

const MS_PER_HOUR = 1000 * 60 * 60;

/** Scheduled hours for one CP row = end - start; 0 when end is null/invalid. */
function shiftHours(startIso: string, endIso: string | null): number {
  if (!endIso) return 0;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return (end - start) / MS_PER_HOUR;
}

function rowLabel(row: CpScheduleRow): string {
  return (
    row.employee_name?.trim() ||
    row.employee_email?.trim() ||
    row.employee_code?.trim() ||
    row.id
  );
}

/** Per-day accumulator that also remembers which shift started earliest. */
interface DayAccum extends CollapsedScheduledShift {
  earliestStartIso: string;
}

/**
 * Resolve CP schedule rows to EPD employees and collapse to the
 * one-row-per-(employee, local date) grain. Pure — unit-tested in isolation.
 */
export function collapseCpSchedule(
  rows: CpScheduleRow[],
  index: ScheduleRosterIndex,
  tz: string
): ScheduleCollapseOutcome {
  const unmatched = new Set<string>();
  const inactiveSkipped = new Set<string>();
  let skippedNoStart = 0;
  let resolvedByCode = 0;
  let resolvedBySevenShiftsId = 0;

  const days = new Map<string, DayAccum>();

  for (const row of rows) {
    let employee: ScheduleRosterEmployee | undefined;
    if (row.employee_code) {
      employee = index.byCode.get(normalizeCode(row.employee_code));
    }
    if (employee) {
      resolvedByCode += 1;
    } else if (row.sevenshifts_user_id != null) {
      employee = index.bySevenShiftsId.get(Number(row.sevenshifts_user_id));
      if (employee) resolvedBySevenShiftsId += 1;
    }
    if (!employee) {
      unmatched.add(rowLabel(row));
      continue;
    }
    if (!employee.active) {
      inactiveSkipped.add(rowLabel(row));
      continue;
    }

    const startLocal = utcToLocalWallClock(row.shift_start_at, tz);
    if (!startLocal) {
      skippedNoStart += 1;
      continue;
    }
    const endLocal = utcToLocalWallClock(row.shift_end_at, tz);
    const hours = shiftHours(row.shift_start_at!, row.shift_end_at ?? null);
    const role = row.role?.trim() || null;

    const key = `${employee.id}|${startLocal.date}`;
    const existing = days.get(key);
    if (!existing) {
      days.set(key, {
        employee_id: employee.id,
        entry_date: startLocal.date,
        in_time: startLocal.time,
        out_time: endLocal?.time ?? null,
        hours,
        role,
        shift_count: 1,
        earliestStartIso: row.shift_start_at!,
      });
    } else {
      existing.shift_count += 1;
      // Earliest in / latest out — the CSV importer's exact merge rule,
      // including its string comparison on local times.
      if (startLocal.time < existing.in_time) existing.in_time = startLocal.time;
      if (endLocal?.time && (!existing.out_time || endLocal.time > existing.out_time)) {
        existing.out_time = endLocal.time;
      }
      existing.hours += hours;
      // Role follows the earliest-starting shift that carried one.
      if (row.shift_start_at! < existing.earliestStartIso) {
        existing.earliestStartIso = row.shift_start_at!;
        if (role) existing.role = role;
      } else if (existing.role === null && role) {
        existing.role = role;
      }
    }
  }

  let multiShiftDays = 0;
  const entries: CollapsedScheduledShift[] = [];
  for (const acc of days.values()) {
    if (acc.shift_count > 1) multiShiftDays += 1;
    entries.push({
      employee_id: acc.employee_id,
      entry_date: acc.entry_date,
      in_time: acc.in_time,
      out_time: acc.out_time,
      hours: acc.hours,
      role: acc.role,
      shift_count: acc.shift_count,
    });
  }

  return {
    entries,
    resolved_by_code: resolvedByCode,
    resolved_by_seven_shifts_id: resolvedBySevenShiftsId,
    unmatched: Array.from(unmatched),
    inactive_skipped: Array.from(inactiveSkipped),
    skipped_no_start: skippedNoStart,
    multi_shift_days: multiShiftDays,
  };
}

/**
 * time_entries upsert payload for one collapsed scheduled shift — the exact
 * column set the CSV-era scheduled path wrote (wage null, pay columns 0).
 */
export function buildScheduledEntryPayload(
  entry: CollapsedScheduledShift,
  locationId: string
) {
  return {
    employee_id: entry.employee_id,
    location_id: locationId,
    entry_date: entry.entry_date,
    entry_type: "scheduled" as const,
    in_time: entry.in_time,
    out_time: entry.out_time,
    role: entry.role,
    wage: null,
    regular_hours: entry.hours,
    ot_hours: 0,
    double_ot_hours: 0,
    holiday_hours: 0,
    regular_pay: 0,
    ot_pay: 0,
    double_ot_pay: 0,
    holiday_pay: 0,
    total_pay: 0,
  };
}
