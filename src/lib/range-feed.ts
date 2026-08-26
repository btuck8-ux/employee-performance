/**
 * Pure helpers for GET /api/scores/range (2026-08-14 range-API sprint).
 * Param validation + wire-row shaping live here so the contract test can pin
 * them without mocking PostgREST; the route file owns auth, the population
 * probe, and the computeMetricsForRange fan-out.
 *
 * The wire contract is the THQ memo
 * (memo-to-training-hq-range-contract-2026-08-14.md), accepted VERBATIM by
 * THQ on 2026-08-14 and therefore LOCKED — deviations are a Tucker decision
 * before merge, never a code-side judgment call.
 */
import type { RangeMetrics } from "./performance-recompute";

/** Earliest queryable window start (contract memo §2 param table). */
export const RANGE_FEED_MIN_START = "2026-01-01";
/** Maximum window size, inclusive of both endpoints (contract memo §2). */
export const RANGE_FEED_MAX_WINDOW_DAYS = 366;
export const RANGE_FEED_DEFAULT_LIMIT = 25;
/** THQ confirmed the 50-row cap on 2026-08-14 — do not raise unilaterally. */
export const RANGE_FEED_MAX_LIMIT = 50;

/** App-minted employee codes: EMP- + zero-padded sequence (mig 004). */
const EMPLOYEE_CODE_RE = /^EMP-\d{6,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Row shape, in locked wire order: the 3 identity fields, the 9 metrics
 * (same wire names as /api/scores, mig 045), the 6 counts (mig 048).
 * Composites are deliberately ABSENT in v1 (contract memo §2 scope note —
 * THQ confirmed; renders "Quarterly only" tiles instead). No hooks for them.
 */
export const RANGE_FEED_FIELDS = [
  "employee_code",
  "location_code",
  "employee_name",
  "on_time_grace_pct",
  "attendance_pct",
  "survey_engagement_pct",
  "customer_service_rating",
  "tattle_rating",
  "tattle_score_food_quality",
  "tattle_score_accuracy",
  "tattle_score_speed_of_service",
  "avg_task_list_completion_pct",
  "surveys_assigned",
  "surveys_completed",
  "customer_review_quantity",
  "tattle_quantity",
  "tasks_accountable",
  "tasks_completed",
] as const;

export interface RangeFeedRow {
  employee_code: string;
  location_code: string;
  employee_name: string;
  on_time_grace_pct: number | null;
  attendance_pct: number | null;
  survey_engagement_pct: number | null;
  customer_service_rating: number | null;
  tattle_rating: number | null;
  tattle_score_food_quality: number | null;
  tattle_score_accuracy: number | null;
  tattle_score_speed_of_service: number | null;
  avg_task_list_completion_pct: number | null;
  surveys_assigned: number;
  surveys_completed: number;
  customer_review_quantity: number;
  tattle_quantity: number;
  tasks_accountable: number;
  tasks_completed: number;
}

export interface RangeFeedParams {
  start: string;
  end: string;
  /** Empty array = no filter (all eight locations). */
  locationCodes: string[];
  employeeCode: string | null;
  page: number;
  limit: number;
}

export type RangeFeedValidation =
  | { ok: true; params: RangeFeedParams }
  | { ok: false; reason: string };

/** Calendar-valid ISO date (rejects pattern-passing junk like 2026-13-99).
 * Exported for the other date-taking feeds/levers (punch-days, worked-time
 * backfill) — one validator, not three regexes. */
export function isValidIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Inclusive day count of [start, end] (both calendar-valid, start <= end). */
export function windowDays(start: string, end: string): number {
  const ms =
    Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * Positive-integer param: strict (junk is a 400, not a silent default).
 * Safe-integer bound (Codex review): an absurd digit string would coerce
 * to Infinity, pass a bare >= 1 check, and serialize pagination.page as
 * JSON null — a wire-contract violation.
 */
function parsePositiveInt(raw: string | null, fallback: number): number | null {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * Validate the query params per the locked contract. Every failure carries
 * a human-readable reason (the route returns it as `{ error }` with 400).
 *
 * `knownLocationCodes` is INJECTED by the caller (the route reads it from
 * `public.locations` via getLocationCodes()) — this module keeps no copy of
 * a fact the database owns, and stays pure/sync for the contract tests.
 */
export function validateRangeParams(
  searchParams: URLSearchParams,
  knownLocationCodes: readonly string[]
): RangeFeedValidation {
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  if (!start || !end) {
    return { ok: false, reason: "start and end are required (YYYY-MM-DD)" };
  }
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
    return {
      ok: false,
      reason: "start and end must be calendar-valid YYYY-MM-DD dates",
    };
  }
  if (start > end) {
    return { ok: false, reason: "start must be on or before end" };
  }
  if (start < RANGE_FEED_MIN_START) {
    return {
      ok: false,
      reason: `start must be on or after ${RANGE_FEED_MIN_START}`,
    };
  }
  const days = windowDays(start, end);
  if (days > RANGE_FEED_MAX_WINDOW_DAYS) {
    return {
      ok: false,
      reason: `window is ${days} days; maximum is ${RANGE_FEED_MAX_WINDOW_DAYS}`,
    };
  }

  const locationCsv = searchParams.get("location_code");
  let locationCodes: string[] = [];
  if (locationCsv !== null) {
    locationCodes = [...new Set(locationCsv.split(",").map((s) => s.trim()))];
    if (locationCodes.length === 0 || locationCodes.some((c) => c === "")) {
      return { ok: false, reason: "location_code must be a CSV of codes" };
    }
    const unknown = locationCodes.find((c) => !knownLocationCodes.includes(c));
    if (unknown) {
      return { ok: false, reason: `Unknown location_code: ${unknown}` };
    }
  }

  const employeeCode = searchParams.get("employee_code");
  if (employeeCode !== null && !EMPLOYEE_CODE_RE.test(employeeCode)) {
    return {
      ok: false,
      reason: "employee_code must match EMP-NNNNNN",
    };
  }

  const page = parsePositiveInt(searchParams.get("page"), 1);
  if (page === null) {
    return { ok: false, reason: "page must be a positive integer" };
  }
  const limit = parsePositiveInt(
    searchParams.get("limit"),
    RANGE_FEED_DEFAULT_LIMIT
  );
  if (limit === null || limit > RANGE_FEED_MAX_LIMIT) {
    return {
      ok: false,
      reason: `limit must be an integer between 1 and ${RANGE_FEED_MAX_LIMIT}`,
    };
  }

  return {
    ok: true,
    params: { start, end, locationCodes, employeeCode, page, limit },
  };
}

/**
 * Deterministic pagination order: (location_code, employee_code), both
 * ascending — pages never shuffle between calls (contract memo §2).
 */
export function compareRangeFeedMembers(
  a: { location_code: string; employee_code: string },
  b: { location_code: string; employee_code: string }
): number {
  return (
    a.location_code.localeCompare(b.location_code) ||
    a.employee_code.localeCompare(b.employee_code)
  );
}

/**
 * Shape one computed RangeMetrics into the locked wire row. Percentages and
 * ratings pass through as-is — null = not-computable-for-this-window, NEVER
 * coalesced to 0. Counts are honest zeros when the window has none of that
 * input (they are counts, not scores). Composites are not emitted.
 */
export function toRangeFeedRow(
  employee: {
    employee_code: string;
    location_code: string;
    employee_name: string;
  },
  m: RangeMetrics
): RangeFeedRow {
  return {
    employee_code: employee.employee_code,
    location_code: employee.location_code,
    employee_name: employee.employee_name,
    on_time_grace_pct: m.on_time_grace_pct,
    attendance_pct: m.attendance_pct,
    survey_engagement_pct: m.survey_engagement_pct,
    customer_service_rating: m.customer_service_rating,
    tattle_rating: m.tattle_rating,
    tattle_score_food_quality: m.tattle_score_food_quality,
    tattle_score_accuracy: m.tattle_score_accuracy,
    tattle_score_speed_of_service: m.tattle_score_speed_of_service,
    avg_task_list_completion_pct: m.avg_task_list_completion_pct,
    surveys_assigned: m.surveys_assigned,
    surveys_completed: m.surveys_completed,
    customer_review_quantity: m.customer_review_quantity,
    tattle_quantity: m.tattle_quantity,
    tasks_accountable: m.tasks_accountable,
    tasks_completed: m.tasks_completed,
  };
}
