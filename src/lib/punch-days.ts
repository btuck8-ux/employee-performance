/**
 * Punch-day coverage math for the EPD -> CulturePulse punch-day feed
 * (frozen-quarter spec addendum 2026-08-25 §4b).
 *
 * CP is building a prune that deletes schedule rows 7shifts no longer
 * returns. The Kevin Montie fence — never prune a ghost that has a matching
 * punch — requires CP to ask EPD, because CP cannot see punches at all. The
 * feed's whole value is the COVERAGE MARKER: "no punch" and "haven't looked
 * yet" must never render identically.
 *
 * THE MARKER MUST NOT BE NAIVE (both obvious implementations are wrong,
 * measured 2026-08-25):
 *   - ingest_runs.window_end OVER-claims: the 09:55 UTC labor run succeeded
 *     at all seven stores with window_end = today, but it ran at 03:55
 *     store-local — before any store opened. A window_end marker reports
 *     today as covered-with-zero-punches and CP prunes same-day rows
 *     believing they were checked.
 *   - max(entry_date) UNDER-claims: a completed day where nobody happened
 *     to punch reads as uncovered, when the honest answer is "covered, and
 *     nobody worked."
 * The correct bound is the store's own clock:
 *
 *   coverage_through = LEAST(
 *     local_date(last_successful_run.window_end),
 *     local_date(last_successful_run.finished_at) - 1 day
 *   )
 *
 * A date is answerable only when the store-local day has ENDED and a
 * successful run has happened since. Only status='success' runs advance the
 * mark — a failed nightly must produce "cannot answer", never a silent
 * green light.
 *
 * Every location resolves its OWN punch source from locations.actuals_source
 * (NOLA's is cake_timesheets, not toast_labor — a hardcoded seven-store
 * table would omit it; a one-source assumption would report it current;
 * both wrong, the second worse). A location with no resolvable source gets
 * an explicit no_punch_source state — absence is never an encoding.
 */

import { utcToLocalWallClock } from "./ingest/sevenshifts/tz";

/** ingest_runs sources that land punches (worked actuals). */
export type PunchSource = "toast_labor" | "cake_timesheets" | "7shifts_time";

/**
 * Resolve a location's punch source from locations.actuals_source — per
 * location, from data, never a hardcoded store table.
 */
export function punchSourceForActuals(
  actualsSource: string | null | undefined
): PunchSource | null {
  switch (actualsSource) {
    case "toast":
      return "toast_labor";
    case "cake":
      return "cake_timesheets";
    case "7shifts":
      return "7shifts_time";
    default:
      return null;
  }
}

/** YYYY-MM-DD + n days, via UTC-noon arithmetic (immune to DST edges). */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The coverage bound for one location's last SUCCESSFUL run. Returns null
 * when finished_at is unparseable (treated as no successful run). A null
 * window_end falls back to the finished_at bound alone — conservative,
 * never wider.
 */
export function coverageThrough(
  windowEnd: string | null,
  finishedAt: string,
  timeZone: string
): string | null {
  const finishedLocal = utcToLocalWallClock(finishedAt, timeZone)?.date ?? null;
  if (!finishedLocal) return null;
  const dayBefore = addDaysIso(finishedLocal, -1);
  const windowEndLocal = windowEnd
    ? utcToLocalWallClock(windowEnd, timeZone)?.date ?? null
    : null;
  if (windowEndLocal === null) return dayBefore;
  return windowEndLocal < dayBefore ? windowEndLocal : dayBefore;
}

/**
 * The local dates a v_worked_intervals row marks as punch days. entry_date
 * is the local clock-in date; a shift whose local end date exceeds its
 * local start date also marks the end date, because a punch for a shift
 * ending after midnight can land on the following date (CP measured 3 such
 * rows in 5,299 since 2026-06-01 — the day-boundary assumption holds, this
 * is the free insurance).
 */
export function punchDayDates(
  shiftStartLocal: string,
  shiftEndLocal: string | null
): string[] {
  const start = shiftStartLocal.slice(0, 10);
  const end = shiftEndLocal?.slice(0, 10) ?? null;
  if (end && end > start) return [start, end];
  return [start];
}

export interface CoverageEntry {
  location_code: string;
  punch_source: PunchSource | null;
  /** Store-local last answerable date; null when nothing is answerable. */
  coverage_through: string | null;
  state: "ok" | "no_punch_source" | "no_successful_run";
  /** The requested-range slice that CAN be answered; null when none can. */
  answerable: { from: string; to: string } | null;
  /** The requested-range slice that CANNOT be answered — explicit, never
   * an empty punch set. Null only when the whole range is answerable. */
  not_answerable: { from: string; to: string } | null;
}

/**
 * One location's coverage row for a requested [rangeFrom, rangeTo]. Every
 * location in scope gets an entry — a missing coverage row reads to a
 * consumer as an unbounded one (the same failure as a missing pagination
 * object): a gap in the answer rendering as a permissive answer.
 */
export function buildCoverageEntry(
  locationCode: string,
  actualsSource: string | null | undefined,
  lastSuccess: { window_end: string | null; finished_at: string } | null,
  timeZone: string,
  rangeFrom: string,
  rangeTo: string
): CoverageEntry {
  const wholeRangeUnanswerable = {
    answerable: null,
    not_answerable: { from: rangeFrom, to: rangeTo },
  };
  const source = punchSourceForActuals(actualsSource);
  if (!source) {
    return {
      location_code: locationCode,
      punch_source: null,
      coverage_through: null,
      state: "no_punch_source",
      ...wholeRangeUnanswerable,
    };
  }
  const through = lastSuccess
    ? coverageThrough(lastSuccess.window_end, lastSuccess.finished_at, timeZone)
    : null;
  if (through === null) {
    return {
      location_code: locationCode,
      punch_source: source,
      coverage_through: null,
      state: "no_successful_run",
      ...wholeRangeUnanswerable,
    };
  }
  const answerableTo = through < rangeTo ? through : rangeTo;
  if (answerableTo < rangeFrom) {
    return {
      location_code: locationCode,
      punch_source: source,
      coverage_through: through,
      state: "ok",
      ...wholeRangeUnanswerable,
    };
  }
  return {
    location_code: locationCode,
    punch_source: source,
    coverage_through: through,
    state: "ok",
    answerable: { from: rangeFrom, to: answerableTo },
    not_answerable:
      answerableTo < rangeTo
        ? { from: addDaysIso(answerableTo, 1), to: rangeTo }
        : null,
  };
}
