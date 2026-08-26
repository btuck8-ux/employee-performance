import type { SupabaseClient } from "@supabase/supabase-js";
import { quarterInfo, type Quarter } from "./quarter";
import { numOrNull } from "@/lib/format";
import {
  computeCustomerServiceScoreBreakdown,
  fetchCustomerServiceWeights,
  type CustomerServiceScoreBreakdown,
  type CustomerServiceWeights,
} from "./customer-service-score";
import {
  computeTotalImpactScoreBreakdown,
  fetchTotalImpactWeights,
  type TotalImpactScoreBreakdown,
  type TotalImpactWeights,
} from "./total-impact-score";

export interface TimeEntryRow {
  entry_date: string;
  entry_type: "scheduled" | "worked";
  in_time: string | null;
}

/** Punctuality grace period in minutes — late if punch-in is more than this past scheduled. */
export const ON_TIME_GRACE_MINUTES = 3;

export interface PerformanceMetrics {
  attendance_pct: number | null;     // 0-100; null if no scheduled shifts OR punches_time_clock=false OR cover-dominated (excluded, never 0)
  on_time_pct: number | null;        // strict: actual_in <= scheduled_in
  on_time_grace_pct: number | null;  // with 3-minute grace period
  covered_shifts: number;
  scheduled_count: number;
  attended_count: number;
  missed_count: number;
  on_time_count: number;
  on_time_grace_count: number;
  /** Cover-ratio guard (Q2-blocker spec 2026-08-25, second layer): true
   * when shift covers dominate a near-empty denominator — the schedule
   * record is not trustworthy enough to publish a percentage against, and
   * attendance/punctuality read null. Fires on the SHAPE of the answer,
   * not a known cause: it would have caught Kevin Montie (5 scheduled, 0
   * matched, 16 covers) with no diagnosis at all. Loud via the lever's
   * null reasons and anomaly listing, never a silent null. */
  cover_dominated: boolean;
}

/**
 * Effective-dating for the non-puncher marker (mig 056, flip spec 2026-08-24
 * §2a). punches_time_clock encodes a fact that can BEGIN at a date — Nick
 * Goins punched normally for three quarters and stopped exactly at COS's
 * Toast go-live — so the exclusion applies only to periods OVERLAPPING
 * [since, ∞). A period that ended before the effective date scores normally
 * (his Q4 2025 is a THQ frozen quarter; nulling it is what the
 * frozen-quarter arrangement exists to prevent). Null since = always.
 *
 * Returns the effective punchesTimeClock to thread into
 * computeMetricsFromEntries for a period ending at `periodEnd` (YYYY-MM-DD).
 */
export function punchesTimeClockForPeriod(
  punchesTimeClock: boolean,
  since: string | null,
  periodEnd: string
): boolean {
  if (punchesTimeClock) return true;
  if (!since) return false;
  return periodEnd < since;
}

/**
 * Convert "HH:MM:SS" 24-hour time string into total minutes since midnight.
 * Returns null if the string is missing or malformed.
 */
function timeToMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = t.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  return h * 60 + min;
}

/**
 * Compute attendance, punctuality (both strict and with 3-min grace), and
 * covered-shifts metrics from a list of pre-fetched time entries for one
 * employee in a given quarter.
 *
 * `opts.scheduledScoredThrough` (YYYY-MM-DD) caps which scheduled dates get
 * scored for attendance. Anything strictly AFTER the cap is silently
 * ignored — these are future-or-unconfirmed shifts that haven't happened
 * yet (or haven't been ingested yet on the worked side), so counting them
 * as "missed" would unfairly tank the attendance %. Default cap = today
 * (UTC). Callers with location context should pass the latest worked-entry
 * date at the location to also handle upload-lag scenarios. The cap does
 * NOT apply to worked entries (those represent confirmed clock-ins) or
 * to covered-shifts counting (a worked-without-schedule on any date is
 * still a covered shift).
 *
 * `opts.metricsStartFloor` (YYYY-MM-DD | null) is THE DEMARCATION FLOOR
 * (mig 066, 2026-08-26 ruling) — the cap's mirror at the other end. Entry
 * dates strictly BEFORE the floor are outside the measured window, exactly
 * as a future date is: not absent, not zero, in no denominator. Unlike the
 * cap, the floor removes BOTH sides — scheduled AND worked/covered —
 * because below-floor punch data is the untrusted record the ruling
 * exists to stop scoring (the cap's asymmetry protects trusted confirmed
 * clock-ins; there is no trusted side below the floor). Null/absent =
 * no floor (NOLA — deliberate; never read as epoch or today).
 */
export interface RemovedShiftEvidence {
  /** min(entry_date) in seven_shifts_shifts at the location — the mirror's
   * coverage boundary, derived per location, never hardcoded. null = the
   * location has no mirror rows at all: correct NOTHING (absent must mean
   * unknown, the mig-072 freshness rule). */
  mirrorCoverageStart: string | null;
  /** Dates carrying a LIVE mirror shift for this employee (not deleted, not
   * tombstoned). null = the employee cannot be judged (no 7shifts user id)
   * — correct nothing for them. */
  liveDates: Set<string> | null;
}

export function computeMetricsFromEntries(
  entries: TimeEntryRow[],
  opts?: {
    scheduledScoredThrough?: string;
    punchesTimeClock?: boolean;
    metricsStartFloor?: string | null;
    /**
     * VENDOR-REMOVED shifts leave the attendance denominator (denominator
     * spec rev 2 §2–§4, Tucker 2026-08-26): 7shifts deletes a shift when it
     * is swapped/covered/reassigned; time_entries keeps it forever, and the
     * residual is 87% never-worked (8.5× enrichment) — those are not
     * absences. A scheduled date is DROPPED from both sides of the ratio
     * when (a) it is on/after the mirror's coverage start, (b) no live
     * mirror shift exists for it, and (c) NO PUNCH matches it. ⛔ (c) is
     * load-bearing: 36 of 279 residual days were worked — a punch outranks
     * a schedule in both directions, so a removed-but-punched day counts
     * ATTENDED, never dropped (the §2 trap). Dates before the mirror's
     * coverage stay in the denominator uncorrected — "let's not infer."
     */
    removedShifts?: RemovedShiftEvidence;
  }
): PerformanceMetrics {
  const cap =
    opts?.scheduledScoredThrough ?? new Date().toISOString().slice(0, 10);
  const floor = opts?.metricsStartFloor ?? null;

  const scheduledByDate = new Map<string, TimeEntryRow>();
  const workedByDate = new Map<string, TimeEntryRow>();

  for (const e of entries) {
    if (floor !== null && e.entry_date < floor) continue; // below the floor: outside the measured window
    if (e.entry_type === "scheduled") scheduledByDate.set(e.entry_date, e);
    else workedByDate.set(e.entry_date, e);
  }

  // Evidenced non-puncher (mig 056, defect 2026-08-24 §11): the employee is
  // EXCLUDED from the attendance/punctuality denominators — null per the
  // wire contracts' not-computable discipline — never scored 0. A salaried
  // manager who structurally doesn't clock in must not read 0% attendance
  // forever. covered_shifts stays real (a worked entry, should one ever
  // appear, is still a confirmed shift).
  if (opts?.punchesTimeClock === false) {
    let covered = 0;
    for (const date of workedByDate.keys()) {
      if (!scheduledByDate.has(date)) covered += 1;
    }
    return {
      attendance_pct: null,
      on_time_pct: null,
      on_time_grace_pct: null,
      covered_shifts: covered,
      scheduled_count: 0,
      attended_count: 0,
      missed_count: 0,
      on_time_count: 0,
      on_time_grace_count: 0,
      cover_dominated: false,
    };
  }

  let attended = 0;
  let missed = 0;
  let onTime = 0;
  let onTimeGrace = 0;

  const rs = opts?.removedShifts;
  for (const [date, sched] of scheduledByDate) {
    if (date > cap) continue; // future / not-yet-confirmed; don't score
    const worked = workedByDate.get(date);
    if (!worked) {
      // §2–§4: removal is evidence about the SCHEDULE, never the person.
      // Only an unpunched, mirror-judgeable, post-coverage date whose live
      // shift is gone leaves the ratio. The punch-first structure above
      // means a removed-but-punched day already counted ATTENDED.
      if (
        rs !== undefined &&
        rs.mirrorCoverageStart !== null &&
        rs.liveDates !== null &&
        date >= rs.mirrorCoverageStart &&
        !rs.liveDates.has(date)
      ) {
        continue; // vendor-removed and unpunched: not an absence — dropped
      }
      missed += 1;
      continue;
    }
    attended += 1;

    const schedMin = timeToMinutes(sched.in_time);
    const workedMin = timeToMinutes(worked.in_time);
    if (schedMin !== null && workedMin !== null) {
      if (workedMin <= schedMin) onTime += 1;
      if (workedMin <= schedMin + ON_TIME_GRACE_MINUTES) onTimeGrace += 1;
    }
  }

  let covered = 0;
  // The guard's cover count is CAP-BOUNDED (Codex blocker, 2026-08-25):
  // covered_shifts itself deliberately counts beyond the cap (a confirmed
  // worked shift is a covered shift whenever it happened), but the guard
  // compares covers against the CAPPED scheduled denominator — post-cap
  // covers in the ratio would null attendance for someone who simply
  // worked extra shifts after the scored-through date.
  let coveredThroughCap = 0;
  for (const date of workedByDate.keys()) {
    if (!scheduledByDate.has(date)) {
      covered += 1;
      if (date <= cap) coveredThroughCap += 1;
    }
  }

  const scheduledCount = attended + missed;

  // COVER-RATIO GUARD (Q2-blocker spec 2026-08-25, Tucker's second layer).
  // Nobody works sixteen unscheduled shifts and zero scheduled ones: when
  // covers OUTNUMBER the scheduled denominator AND the cover count is
  // non-trivial, the schedule record is the untrustworthy side, and a
  // confident percentage against it is a lie. Threshold from the data,
  // not taste: the fixture is Kevin Montie (5 scheduled / 0 matched / 16
  // covers) while normal profiles run 20-40 scheduled days against 0-3
  // covers per quarter — `covered > scheduled` means the MAJORITY of the
  // person's working days were unscheduled, and `covered >= 5` keeps a
  // part-timer's 2-cover week from tripping it. Counts stay real; only
  // the percentages go not-computable.
  const coverDominated = coveredThroughCap > scheduledCount && coveredThroughCap >= 5;

  const attendance_pct =
    !coverDominated && scheduledCount > 0 ? (attended / scheduledCount) * 100 : null;
  const on_time_pct =
    !coverDominated && attended > 0 ? (onTime / attended) * 100 : null;
  const on_time_grace_pct =
    !coverDominated && attended > 0 ? (onTimeGrace / attended) * 100 : null;

  return {
    attendance_pct,
    on_time_pct,
    on_time_grace_pct,
    covered_shifts: covered,
    scheduled_count: scheduledCount,
    attended_count: attended,
    missed_count: missed,
    on_time_count: onTime,
    on_time_grace_count: onTimeGrace,
    cover_dominated: coverDominated,
  };
}

/**
 * Full metrics object for one employee over an arbitrary date window.
 * Used both by the quarterly recompute and by custom-range report generation.
 */
export interface RangeMetrics {
  // shift / punctuality
  attendance_pct: number | null;
  on_time_pct: number | null;
  on_time_grace_pct: number | null;
  covered_shifts: number;
  scheduled_count: number;
  attended_count: number;
  missed_count: number;
  on_time_count: number;
  on_time_grace_count: number;
  /** Cover-ratio guard flag — see PerformanceMetrics.cover_dominated. */
  cover_dominated: boolean;
  /** Ruling 8 at the wire boundary (packet 5 §7.3): true when
   * punches_time_clock excluded this person from the attendance
   * denominator for the window. The count fields above then hold the
   * compute path's internal ZEROS — placeholders, not facts (the person's
   * scheduled days exist; they are deliberately not judged) — and every
   * wire surface must serve the counts as NULL, never 0. */
  attendance_denominator_excluded: boolean;
  // surveys
  surveys_assigned: number;
  surveys_completed: number;
  survey_engagement_pct: number | null;
  // tasks
  tasks_accountable: number;
  tasks_completed: number;
  tasks_owned: number;
  task_completion_pct: number | null;
  task_list_completion_pct: number | null;
  avg_task_list_completion_pct: number | null;
  // tattle
  tattle_quantity: number;
  tattle_rating: number | null;
  tattle_score_food_quality: number | null;
  tattle_score_accuracy: number | null;
  tattle_score_speed_of_service: number | null;
  // customer reviews
  customer_review_quantity: number;
  customer_service_rating: number | null;
  // THE DEMARCATION FLOOR (§2, 2026-08-26): the labor window actually
  // scored after clamping to the location's metrics_start_date. The
  // asterisk is a first-class field, not a footnote — a clamped range must
  // say so, never silently narrow. labor_window_start is null when the
  // WHOLE requested window sits below the floor (not answerable — distinct
  // from an empty result). Neither field ships on any partner wire (the
  // feed routes pick their fields explicitly; feeds are NOT floor-gated).
  labor_window_start: string | null;
  labor_window_clamped: boolean;
  // POS tips (presence-based; null when no sales data exists for the window)
  hours_worked: number | null;
  sales_during_presence: number | null;
  tips_during_presence: number | null;
  tip_rate_pct: number | null;
  tip_per_hour: number | null;
  location_tip_rate_pct: number | null;
  location_tip_per_hour: number | null;
  tip_rate_delta_pp: number | null;
  // Kitchen Speed v2 (043; reported metric, NOT a scored component).
  // Attribution is on-the-clock overlap only — no role filter — so this is a
  // shared shift outcome, not an individual skill. residual = the employee's
  // avg prep minus the store's same-hour baseline (negative = faster).
  // Always stored whenever attributed items exist, at ANY shift count
  // (2026-07-29 amendment): the number is real at every n — only its
  // precision varies — and thin-sample judgment belongs to the human reading
  // it, not a gate in the code. All null only when NO data exists: never on
  // the clock at a kitchen-enabled store (NOLA) or pre-Toast-go-live.
  kitchen_items: number | null;
  kitchen_tickets: number | null;
  kitchen_shifts: number | null;
  kitchen_avg_prep_seconds: number | null;
  // Volume-weighted store baseline over the employee's same items/hours.
  // Not persisted (derivable as avg - residual); custom-range reports use it
  // directly.
  kitchen_baseline_prep_seconds: number | null;
  location_kitchen_avg_prep_seconds: number | null;
  kitchen_residual_seconds: number | null;
  // Phase 9 — Customer Service Score (composite). Null composite when fewer
  // than 2 of 3 components are present. Per-component scores + effective
  // weights are kept in `customer_service_score_breakdown` so the dashboard
  // drill-down and PDF breakdown render without re-deriving the math.
  customer_service_score: number | null;
  customer_service_score_components_count: number;
  customer_service_score_breakdown: CustomerServiceScoreBreakdown;
  // Phase 10 — Total Impact Score (composite). Null composite when fewer
  // than 4 of 5 components are present. Per-component scores + effective
  // weights are kept in `total_impact_score_breakdown` so the dashboard
  // tile + drilldown render without re-deriving the math. Eligibility for
  // ranking is computed separately at the ranking surface.
  total_impact_score: number | null;
  total_impact_score_components_count: number;
  total_impact_score_breakdown: TotalImpactScoreBreakdown;
}

/**
 * Per-employee tip metrics over a date window, computed by the
 * `compute_employee_tip_metrics` SQL function. Returns the canonical
 * presence-based numbers: employee tip rate, employee tip/hour, the
 * matching location baselines, and the tip_rate_delta_pp that drives
 * the badge on the dashboard.
 *
 * Returns null fields when no sales data is present for the (employee,
 * location, window) — keeps the PDF renderer free to hide the section.
 *
 * The SQL function returns numeric columns, which the postgres driver
 * serializes as strings; this helper normalizes them to number|null.
 */
async function fetchTipMetrics(
  supabase: SupabaseClient,
  employeeId: string,
  locationId: string,
  periodStart: string,
  periodEnd: string
): Promise<{
  hours_worked: number | null;
  sales_during_presence: number | null;
  tips_during_presence: number | null;
  tip_rate_pct: number | null;
  tip_per_hour: number | null;
  location_tip_rate_pct: number | null;
  location_tip_per_hour: number | null;
  tip_rate_delta_pp: number | null;
}> {
  const nullTips = {
    hours_worked: null,
    sales_during_presence: null,
    tips_during_presence: null,
    tip_rate_pct: null,
    tip_per_hour: null,
    location_tip_rate_pct: null,
    location_tip_per_hour: null,
    tip_rate_delta_pp: null,
  };
  const { data, error } = await supabase.rpc("compute_employee_tip_metrics", {
    p_employee_id: employeeId,
    p_location_id: locationId,
    p_period_start: periodStart,
    p_period_end: periodEnd,
  });
  if (error) {
    console.error("[performance-recompute] tip metrics error:", error.message);
    return nullTips;
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        sales_under_cap: number | string | null;
        tips_under_cap: number | string | null;
        hours_worked: number | string | null;
        employee_tip_rate_pct: number | string | null;
        employee_tip_per_hour: number | string | null;
        location_avg_tip_rate_pct: number | string | null;
        location_avg_tip_per_hour: number | string | null;
        tip_rate_delta_pp: number | string | null;
      }
    | null
    | undefined;
  if (!row) return nullTips;


  // If both employee and location have zero qualifying sales, treat tips as
  // unavailable for the window — the function still returns 0 totals but
  // there's no meaningful metric to display.
  const employeeSales = numOrNull(row.sales_under_cap) ?? 0;
  const locationRate = numOrNull(row.location_avg_tip_rate_pct);
  if (employeeSales === 0 && locationRate === null) return nullTips;

  return {
    hours_worked: numOrNull(row.hours_worked),
    sales_during_presence: numOrNull(row.sales_under_cap),
    tips_during_presence: numOrNull(row.tips_under_cap),
    tip_rate_pct: numOrNull(row.employee_tip_rate_pct),
    tip_per_hour: numOrNull(row.employee_tip_per_hour),
    location_tip_rate_pct: numOrNull(row.location_avg_tip_rate_pct),
    location_tip_per_hour: numOrNull(row.location_avg_tip_per_hour),
    tip_rate_delta_pp: numOrNull(row.tip_rate_delta_pp),
  };
}

/**
 * Per-employee Kitchen Speed v2 over a date window, via the
 * `compute_kitchen_speed` / `compute_location_kitchen_speed` SQL functions
 * (migration 043). Attribution happens inside the employee function: an item
 * counts iff the employee was on the clock at that location when the ticket
 * fired — NO role filter (the CO role vocabulary is a scheduling hierarchy,
 * not stations) and NO worked_that_day fallback. The metric is the mean
 * residual vs the store's own per-hour baseline over the same period, so it
 * measures within-store relative standing (never describe it as
 * "improvement" — absolute change lives on the location aggregate).
 *
 * The residual is stored at ANY shift count (2026-07-29 amendment reversing
 * the v2 §3 floor). Measured day-to-day residual SD is ~114s, so the SE on
 * an employee's residual is ~114/sqrt(shifts): 1 shift ≈ ±114s, 4 ≈ ±57s,
 * 15 ≈ ±29s, 60 ≈ ±15s. The number is real at every n — only its precision
 * varies; a 1-shift residual truly measures that shift, it just shouldn't be
 * read as a trait. That's a human-judgment matter: ~15 shifts remains the
 * best-practice reading floor (advisory only — the PDF gates the rating
 * badge and adds a "directional only" footnote below it, nothing suppresses
 * the number itself).
 */
async function fetchKitchenMetrics(
  supabase: SupabaseClient,
  employeeId: string,
  locationId: string,
  periodStart: string,
  periodEnd: string
): Promise<{
  kitchen_items: number | null;
  kitchen_tickets: number | null;
  kitchen_shifts: number | null;
  kitchen_avg_prep_seconds: number | null;
  kitchen_baseline_prep_seconds: number | null;
  location_kitchen_avg_prep_seconds: number | null;
  kitchen_residual_seconds: number | null;
}> {
  const nullKitchen = {
    kitchen_items: null,
    kitchen_tickets: null,
    kitchen_shifts: null,
    kitchen_avg_prep_seconds: null,
    kitchen_baseline_prep_seconds: null,
    location_kitchen_avg_prep_seconds: null,
    kitchen_residual_seconds: null,
  };


  const { data: empData, error: empError } = await supabase.rpc("compute_kitchen_speed", {
    p_employee_id: employeeId,
    p_location_id: locationId,
    p_start: periodStart,
    p_end: periodEnd,
  });
  if (empError) {
    console.error("[performance-recompute] kitchen metrics error:", empError.message);
    return nullKitchen;
  }
  const emp = (Array.isArray(empData) ? empData[0] : empData) as
    | {
        items: number | string | null;
        tickets: number | string | null;
        shifts: number | string | null;
        avg_prep_seconds: number | string | null;
        baseline_prep_seconds: number | string | null;
        residual_seconds: number | string | null;
      }
    | null
    | undefined;
  const empItems = numOrNull(emp?.items) ?? 0;
  const empAvg = numOrNull(emp?.avg_prep_seconds);
  // No attributed items = never on the clock at a kitchen-enabled store in
  // the window (or no kitchen data yet) — the whole block stays null.
  if (empItems === 0 || empAvg === null) return nullKitchen;

  const { data: locData, error: locError } = await supabase.rpc(
    "compute_location_kitchen_speed",
    { p_location_id: locationId, p_start: periodStart, p_end: periodEnd }
  );
  if (locError) {
    console.error("[performance-recompute] location kitchen error:", locError.message);
    return nullKitchen;
  }
  const locRow = (Array.isArray(locData) ? locData[0] : locData) as
    | { avg_prep_seconds: number | string | null }
    | null
    | undefined;

  return {
    kitchen_items: empItems,
    kitchen_tickets: numOrNull(emp?.tickets),
    kitchen_shifts: numOrNull(emp?.shifts) ?? 0,
    kitchen_avg_prep_seconds: empAvg,
    kitchen_baseline_prep_seconds: numOrNull(emp?.baseline_prep_seconds),
    location_kitchen_avg_prep_seconds: numOrNull(locRow?.avg_prep_seconds),
    kitchen_residual_seconds: numOrNull(emp?.residual_seconds),
  };
}

/**
 * Compute every metric for one (employee, location) over an arbitrary
 * inclusive date range (YYYY-MM-DD strings). Pure compute — does NOT write
 * to performance_records. The quarterly recompute and the custom-range
 * report generator both call this so the math stays in lockstep.
 */
export async function computeMetricsForRange(
  supabase: SupabaseClient,
  employeeId: string,
  locationId: string,
  periodStart: string,
  periodEnd: string,
  opts?: {
    csWeights?: CustomerServiceWeights;
    tisWeights?: TotalImpactWeights;
  }
): Promise<{ ok: true; metrics: RangeMetrics } | { ok: false; error: string }> {
  // THE FLIP (2026-08-25): entries come from flip-entries.ts — Toast
  // punches + the pruned direct-feed schedule at Toast stores (go-live
  // split / day-conditional fallback live there), time_entries at NOLA.
  let entries: TimeEntryRow[];
  let latestWorkedDate: string | null;
  let metricsStart: string | null;
  let removedEvidence: RemovedShiftEvidence | undefined;
  try {
    const {
      fetchLocationFlipMeta,
      fetchEffectiveEntries,
      latestEffectiveWorkedDate,
      fetchRemovedShiftEvidence,
    } = await import("./flip-entries");
    const meta = await fetchLocationFlipMeta(supabase, locationId);
    metricsStart = meta.metricsStart;
    const byEmployee = await fetchEffectiveEntries(
      supabase,
      locationId,
      [employeeId],
      { start: periodStart, end: periodEnd },
      meta
    );
    entries = byEmployee.get(employeeId) ?? [];
    latestWorkedDate = await latestEffectiveWorkedDate(supabase, locationId, meta);
    // Denominator spec rev 2 §3–§4: vendor-removed, unpunched scheduled
    // days leave the ratio (judged against the live mirror, coverage-
    // bounded per location).
    removedEvidence = (
      await fetchRemovedShiftEvidence(supabase, locationId, [employeeId], {
        start: periodStart,
        end: periodEnd,
      })
    ).get(employeeId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Non-puncher marker (mig 056): excluded from the attendance denominator —
  // but only for periods overlapping the effective date (§2a).
  const { data: empRow } = await supabase
    .from("employees")
    .select("punches_time_clock, punches_time_clock_since")
    .eq("id", employeeId)
    .maybeSingle();
  const punchesTimeClock = punchesTimeClockForPeriod(
    empRow?.punches_time_clock !== false,
    (empRow?.punches_time_clock_since as string | null) ?? null,
    periodEnd
  );

  // Cap attendance scoring at min(today, latest EFFECTIVE worked date at
  // this location — Toast punches at Toast stores). This stops
  // future-scheduled shifts from being counted as "missed" when the
  // schedule lands ahead of the worked side.
  const todayIso = new Date().toISOString().slice(0, 10);
  const scheduledScoredThrough =
    latestWorkedDate !== null && latestWorkedDate < todayIso
      ? latestWorkedDate
      : todayIso;

  // THE DEMARCATION FLOOR (mig 066): labor entries below the location's
  // metrics_start_date are outside the measured window — the cap's mirror.
  // The tip metrics clamp themselves inside compute_employee_tip_metrics
  // (same floor, SQL side — TS↔SQL lockstep by construction).
  const laborWindowStart =
    metricsStart !== null && metricsStart > periodEnd
      ? null // whole window below the floor — not answerable
      : metricsStart !== null && metricsStart > periodStart
        ? metricsStart
        : periodStart;
  const laborWindowClamped = laborWindowStart !== periodStart;

  const shift = computeMetricsFromEntries(
    entries,
    {
      scheduledScoredThrough,
      punchesTimeClock,
      metricsStartFloor: metricsStart,
      removedShifts: removedEvidence,
    }
  );

  // ---- Tattle metrics ----
  const { data: attributedSurveys } = await supabase
    .from("tattle_attributions")
    .select(
      "tattle_surveys!inner(tattle_rating, food_quality_score, accuracy_score, speed_of_service_score, date_experienced)"
    )
    .eq("employee_id", employeeId)
    .gte("tattle_surveys.date_experienced", periodStart)
    .lte("tattle_surveys.date_experienced", periodEnd);

  type TattleRollup = {
    tattle_rating: number | string | null;
    food_quality_score: number | string | null;
    accuracy_score: number | string | null;
    speed_of_service_score: number | string | null;
  };
  const surveys = ((attributedSurveys ?? []) as unknown as Array<{
    tattle_surveys: TattleRollup;
  }>)
    .map((r) => r.tattle_surveys)
    .filter(Boolean);

  const numOrNull = (v: number | string | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === "string" ? Number(v) : v;
    return Number.isNaN(n) ? null : n;
  };
  const avgNonNull = (xs: (number | null)[]): number | null => {
    const filtered = xs.filter((x): x is number => x !== null);
    if (filtered.length === 0) return null;
    return filtered.reduce((a, b) => a + b, 0) / filtered.length;
  };

  const tattle_quantity = surveys.length;
  const tattle_rating = avgNonNull(surveys.map((s) => numOrNull(s.tattle_rating)));
  const tattle_score_food_quality = avgNonNull(
    surveys.map((s) => numOrNull(s.food_quality_score))
  );
  const tattle_score_accuracy = avgNonNull(
    surveys.map((s) => numOrNull(s.accuracy_score))
  );
  const tattle_score_speed_of_service = avgNonNull(
    surveys.map((s) => numOrNull(s.speed_of_service_score))
  );

  // ---- Customer reviews ----
  const { data: attributedReviews } = await supabase
    .from("review_attributions")
    .select("customer_reviews!inner(rating, review_date)")
    .eq("employee_id", employeeId)
    .gte("customer_reviews.review_date", periodStart)
    .lte("customer_reviews.review_date", periodEnd);

  type ReviewRollup = { rating: number | string | null };
  const reviews = ((attributedReviews ?? []) as unknown as Array<{
    customer_reviews: ReviewRollup;
  }>)
    .map((r) => r.customer_reviews)
    .filter(Boolean);

  const customer_review_quantity = reviews.length;
  const customer_service_rating = avgNonNull(reviews.map((r) => numOrNull(r.rating)));

  // ---- Survey engagement ----
  const { data: surveyRows } = await supabase
    .from("survey_assignments")
    .select("completed, surveys!inner(sent_date)")
    .eq("employee_id", employeeId)
    .gte("surveys.sent_date", periodStart)
    .lte("surveys.sent_date", periodEnd);

  const assignments = (surveyRows ?? []) as unknown as Array<{
    completed: boolean;
    surveys: { sent_date: string | null };
  }>;
  const surveys_assigned = assignments.length;
  const surveys_completed = assignments.filter((a) => a.completed).length;
  const survey_engagement_pct =
    surveys_assigned > 0 ? (surveys_completed / surveys_assigned) * 100 : null;

  // ---- Tasks ----
  type AcctRow = {
    tasks: {
      id: string;
      task_list_name: string;
      task_date: string;
      is_complete: boolean;
    } | null;
  };
  const { data: acctRows } = await supabase
    .from("task_accountability")
    .select("tasks!inner(id, task_list_name, task_date, is_complete)")
    .eq("employee_id", employeeId)
    .gte("tasks.task_date", periodStart)
    .lte("tasks.task_date", periodEnd);

  const accountableTasks = ((acctRows ?? []) as unknown as AcctRow[])
    .map((r) => r.tasks)
    .filter((t): t is NonNullable<typeof t> => Boolean(t));

  const tasks_accountable = accountableTasks.length;
  const tasks_completed_count = accountableTasks.filter((t) => t.is_complete).length;
  const task_completion_pct =
    tasks_accountable > 0 ? (tasks_completed_count / tasks_accountable) * 100 : null;

  const { data: ownedRows } = await supabase
    .from("task_owners")
    .select("tasks!inner(task_date)")
    .eq("employee_id", employeeId)
    .gte("tasks.task_date", periodStart)
    .lte("tasks.task_date", periodEnd);
  const tasks_owned = (ownedRows ?? []).length;

  // Per-list-instance completion math (same as recompute logic)
  const accountableLists = new Map<string, string[]>();
  for (const t of accountableTasks) {
    const k = `${t.task_list_name.toLowerCase()}|${t.task_date}`;
    const list = accountableLists.get(k);
    if (list) list.push(t.id);
    else accountableLists.set(k, [t.id]);
  }

  let task_list_completion_pct: number | null = null;
  let avg_task_list_completion_pct: number | null = null;

  if (accountableLists.size > 0) {
    // Pull every task at this location whose date is in our accountable date
    // set in ONE query, then aggregate in JS. The previous implementation ran
    // a separate query per (list, date) pair — for an employee accountable
    // across e.g. 4 task lists × 60 days that's ~240 sequential round-trips,
    // and bulk-generate compounds it across employees. Single query slashes
    // recompute time by 50–100x in practice.
    const accountableDates = new Set<string>();
    for (const k of accountableLists.keys()) {
      accountableDates.add(k.split("|")[1]);
    }
    const accountableDatesArray = Array.from(accountableDates);

    const { data: allListTasks } = await supabase
      .from("tasks")
      .select("is_complete, task_list_name, task_date")
      .eq("location_id", locationId)
      .in("task_date", accountableDatesArray)
      .range(0, 99999);

    // Group by (lower(list_name), date) and only keep groups whose key is
    // in the accountable set — a single date may contain task lists the
    // employee was NOT accountable for (other roles), and those don't count.
    const groupCounts = new Map<string, { total: number; done: number }>();
    for (const t of allListTasks ?? []) {
      const listLower = (t.task_list_name as string).toLowerCase();
      const key = `${listLower}|${t.task_date as string}`;
      if (!accountableLists.has(key)) continue;
      const ex = groupCounts.get(key);
      if (!ex) {
        groupCounts.set(key, { total: 1, done: t.is_complete ? 1 : 0 });
      } else {
        ex.total += 1;
        if (t.is_complete) ex.done += 1;
      }
    }

    const completionByList: number[] = [];
    let listsAtHundred = 0;
    for (const { total, done } of groupCounts.values()) {
      if (total === 0) continue;
      completionByList.push((done / total) * 100);
      if (done === total) listsAtHundred += 1;
    }

    if (completionByList.length > 0) {
      task_list_completion_pct = (listsAtHundred / completionByList.length) * 100;
      avg_task_list_completion_pct =
        completionByList.reduce((a, b) => a + b, 0) / completionByList.length;
    }
  }

  // ---- POS tip metrics (presence-based; SQL function handles overlap math) ----
  const tip = await fetchTipMetrics(
    supabase,
    employeeId,
    locationId,
    periodStart,
    periodEnd
  );

  // ---- Kitchen Speed (reported metric; not scored) ----
  const kitchen = await fetchKitchenMetrics(
    supabase,
    employeeId,
    locationId,
    periodStart,
    periodEnd
  );

  // ---- Customer Service Score (Phase 9) ----
  const csWeights = opts?.csWeights ?? (await fetchCustomerServiceWeights(supabase));
  const csBreakdown = computeCustomerServiceScoreBreakdown(
    tattle_rating,
    customer_service_rating,
    tip.tip_rate_delta_pp,
    csWeights
  );

  // ---- Total Impact Score (Phase 10) ----
  // A non-null csBreakdown.composite_score already encodes "Phase 9 composite
  // present" (Phase 9 writes NULL for single-source / no-data states), which
  // is the exact semantic TIS wants for its 5-component count.
  const tisWeights = opts?.tisWeights ?? (await fetchTotalImpactWeights(supabase));
  const tisBreakdown = computeTotalImpactScoreBreakdown(
    csBreakdown.composite_score,
    shift.attendance_pct,
    shift.on_time_grace_pct,
    avg_task_list_completion_pct,
    survey_engagement_pct,
    tisWeights
  );

  return {
    ok: true,
    metrics: {
      attendance_pct: shift.attendance_pct,
      on_time_pct: shift.on_time_pct,
      on_time_grace_pct: shift.on_time_grace_pct,
      covered_shifts: shift.covered_shifts,
      scheduled_count: shift.scheduled_count,
      attended_count: shift.attended_count,
      missed_count: shift.missed_count,
      on_time_count: shift.on_time_count,
      on_time_grace_count: shift.on_time_grace_count,
      cover_dominated: shift.cover_dominated,
      attendance_denominator_excluded: !punchesTimeClock,
      labor_window_start: laborWindowStart,
      labor_window_clamped: laborWindowClamped,
      surveys_assigned,
      surveys_completed,
      survey_engagement_pct,
      tasks_accountable,
      tasks_completed: tasks_completed_count,
      tasks_owned,
      task_completion_pct,
      task_list_completion_pct,
      avg_task_list_completion_pct,
      tattle_quantity,
      tattle_rating,
      tattle_score_food_quality,
      tattle_score_accuracy,
      tattle_score_speed_of_service,
      customer_review_quantity,
      customer_service_rating,
      ...tip,
      ...kitchen,
      customer_service_score: csBreakdown.composite_score,
      customer_service_score_components_count: csBreakdown.components_count,
      customer_service_score_breakdown: csBreakdown,
      total_impact_score: tisBreakdown.composite_score,
      total_impact_score_components_count: tisBreakdown.components_count,
      total_impact_score_breakdown: tisBreakdown,
    },
  };
}

/**
 * The frozen-quarter guard (frozen-quarter spec 2026-08-25 §1). Pure
 * decision: returns null when the write may proceed, or the refusal message.
 *
 * A guard attached to a caller protects that caller; a guard attached to the
 * asset protects the asset. recomputePerformanceForQuarter has ~20 write
 * paths behind it — this is the ONE implementation of frozen-ness, reading
 * report_periods.frozen (mig 063), and every caller goes through it.
 *
 * The override is an explicit option naming the exact quarter
 * (allowFrozenQuarter: "Q4-2025"). A boolean is not acceptable — it can be
 * passed by a caller that has no idea which quarter it is about to touch,
 * which is precisely how the 2026-08-25 fan-out incident happened.
 */
export const FROZEN_REFUSAL_PREFIX = "refusing recompute of frozen";

export function frozenQuarterRefusal(
  frozen: boolean,
  year: number,
  quarter: Quarter,
  allowFrozenQuarter: string | undefined
): string | null {
  if (!frozen) return null;
  const label = `Q${quarter}-${year}`;
  if (allowFrozenQuarter === label) return null;
  if (allowFrozenQuarter !== undefined) {
    return `${FROZEN_REFUSAL_PREFIX} ${label}: override names "${allowFrozenQuarter}", not this quarter`;
  }
  return `${FROZEN_REFUSAL_PREFIX} ${label}: this quarter is frozen (THQ arrangement) — recomputing it requires allowFrozenQuarter: "${label}", named exactly`;
}

/** What a recompute write actually did — "employees touched" concealed two
 * row-conjuring incidents (frozen-quarter spec 2026-08-25 §3); created vs
 * updated vs skipped must never collapse into one count again. */
export type RecomputeWriteAction = "created" | "updated" | "skipped_no_activity";

/**
 * The no-conjuring rule (frozen-quarter spec 2026-08-25 §3): a recompute
 * must not create a row for an (employee, period) with no scheduled, worked,
 * or attributed activity. Pure decision over the activity signals the
 * recompute already computed. An EXISTING row still updates — an employee
 * who genuinely went quiet gets refreshed to null, not left stale.
 */
export function periodHasActivity(signals: {
  entry_count: number;
  tattle_quantity: number;
  customer_review_quantity: number;
  surveys_assigned: number;
  tasks_accountable: number;
  tasks_owned: number;
  hours_worked: number | null;
  kitchen_items: number | null;
}): boolean {
  return (
    signals.entry_count > 0 ||
    signals.tattle_quantity > 0 ||
    signals.customer_review_quantity > 0 ||
    signals.surveys_assigned > 0 ||
    signals.tasks_accountable > 0 ||
    signals.tasks_owned > 0 ||
    (signals.hours_worked ?? 0) > 0 ||
    (signals.kitchen_items ?? 0) > 0
  );
}

/**
 * Recompute and upsert the performance_records row for one (employee, quarter).
 * Pulls all time_entries for the employee within the quarter window and writes
 * attendance_pct, on_time_pct, on_time_grace_pct, covered_shifts. Other metric
 * columns are left untouched if the row exists.
 *
 * Refuses (ok:false, no write) when the target period is frozen
 * (report_periods.frozen) and opts.allowFrozenQuarter does not name it
 * exactly — see frozenQuarterRefusal. Skips (ok:true,
 * action:"skipped_no_activity", no write) when no row exists and the
 * employee has no activity in the period — see periodHasActivity.
 */
export async function recomputePerformanceForQuarter(
  supabase: SupabaseClient,
  employeeId: string,
  locationId: string,
  year: number,
  quarter: Quarter,
  opts?: {
    csWeights?: CustomerServiceWeights;
    tisWeights?: TotalImpactWeights;
    /** Exact quarter label ("Q4-2025") authorizing a frozen-period write. */
    allowFrozenQuarter?: string;
  }
): Promise<
  | { ok: true; metrics: PerformanceMetrics; action: RecomputeWriteAction }
  | { ok: false; error: string }
> {
  const q = quarterInfo(year, quarter);
  const periodStart = q.periodStart.toISOString().slice(0, 10);
  const periodEnd = q.periodEnd.toISOString().slice(0, 10);

  const { data: period, error: periodError } = await supabase
    .from("report_periods")
    .select("id, frozen")
    .eq("year", year)
    .eq("quarter", quarter)
    .maybeSingle();
  if (periodError) return { ok: false, error: `report_periods read: ${periodError.message}` };

  // Frozen-quarter guard — BEFORE any write. Return ok:false, never throw:
  // runRecomputeJobs collects failures into an array, so a nightly that
  // inadvertently targets a frozen quarter logs a failure per job and keeps
  // going instead of dying mid-run on a partial write.
  const refusal = frozenQuarterRefusal(
    period?.frozen === true,
    year,
    quarter,
    opts?.allowFrozenQuarter
  );
  if (refusal) return { ok: false, error: refusal };

  let reportPeriodId = period?.id;
  if (!reportPeriodId) {
    const { data: rpcId } = await supabase.rpc("upsert_quarter", {
      p_year: year,
      p_quarter: quarter,
    });
    reportPeriodId = rpcId as string | null;
    if (!reportPeriodId) {
      return { ok: false, error: `Could not resolve report_period for ${year}-Q${quarter}` };
    }
  }

  // THE FLIP (2026-08-25): flip-entries.ts sources — see
  // computeMetricsForRange for the rules.
  let entries: TimeEntryRow[];
  let latestWorkedDate: string | null;
  let metricsStart: string | null;
  let removedEvidence: RemovedShiftEvidence | undefined;
  try {
    const {
      fetchLocationFlipMeta,
      fetchEffectiveEntries,
      latestEffectiveWorkedDate,
      fetchRemovedShiftEvidence,
    } = await import("./flip-entries");
    const meta = await fetchLocationFlipMeta(supabase, locationId);
    metricsStart = meta.metricsStart;
    const byEmployee = await fetchEffectiveEntries(
      supabase,
      locationId,
      [employeeId],
      { start: periodStart, end: periodEnd },
      meta
    );
    entries = byEmployee.get(employeeId) ?? [];
    latestWorkedDate = await latestEffectiveWorkedDate(supabase, locationId, meta);
    // Denominator spec rev 2 §3–§4 (same evidence as computeMetricsForRange).
    removedEvidence = (
      await fetchRemovedShiftEvidence(supabase, locationId, [employeeId], {
        start: periodStart,
        end: periodEnd,
      })
    ).get(employeeId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Non-puncher marker (mig 056): excluded from the attendance denominator —
  // but only for periods overlapping the effective date (§2a).
  const { data: empRow } = await supabase
    .from("employees")
    .select("punches_time_clock, punches_time_clock_since")
    .eq("id", employeeId)
    .maybeSingle();
  const punchesTimeClock = punchesTimeClockForPeriod(
    empRow?.punches_time_clock !== false,
    (empRow?.punches_time_clock_since as string | null) ?? null,
    periodEnd
  );

  // Cap attendance scoring at min(today, latest EFFECTIVE worked date) — see
  // computeMetricsForRange for the rationale.
  const todayIso = new Date().toISOString().slice(0, 10);
  const scheduledScoredThrough =
    latestWorkedDate !== null && latestWorkedDate < todayIso
      ? latestWorkedDate
      : todayIso;

  // THE DEMARCATION FLOOR (mig 066): a straddling quarter (HOU Q2) scores
  // from the floor forward as a partial period; a wholly-below-floor
  // quarter's labor metrics go null with zero counts. Tip metrics clamp
  // themselves inside compute_employee_tip_metrics (SQL side, same floor).
  const metrics = computeMetricsFromEntries(
    entries,
    {
      scheduledScoredThrough,
      punchesTimeClock,
      metricsStartFloor: metricsStart,
      removedShifts: removedEvidence,
    }
  );

  // ---- Tattle metrics (attributed surveys whose date_experienced is in this quarter) ----
  const { data: attributedSurveys } = await supabase
    .from("tattle_attributions")
    .select(
      "tattle_surveys!inner(tattle_rating, food_quality_score, accuracy_score, speed_of_service_score, date_experienced)"
    )
    .eq("employee_id", employeeId)
    .gte("tattle_surveys.date_experienced", periodStart)
    .lte("tattle_surveys.date_experienced", periodEnd);

  type TattleRollup = {
    tattle_rating: number | string | null;
    food_quality_score: number | string | null;
    accuracy_score: number | string | null;
    speed_of_service_score: number | string | null;
  };
  const surveys = ((attributedSurveys ?? []) as unknown as Array<{
    tattle_surveys: TattleRollup;
  }>)
    .map((r) => r.tattle_surveys)
    .filter(Boolean);

  const numOrNull = (v: number | string | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === "string" ? Number(v) : v;
    return Number.isNaN(n) ? null : n;
  };
  const avgNonNull = (xs: (number | null)[]): number | null => {
    const filtered = xs.filter((x): x is number => x !== null);
    if (filtered.length === 0) return null;
    return filtered.reduce((a, b) => a + b, 0) / filtered.length;
  };

  const tattle_quantity = surveys.length;
  const tattle_rating = avgNonNull(surveys.map((s) => numOrNull(s.tattle_rating)));
  const tattle_score_food_quality = avgNonNull(
    surveys.map((s) => numOrNull(s.food_quality_score))
  );
  const tattle_score_accuracy = avgNonNull(
    surveys.map((s) => numOrNull(s.accuracy_score))
  );
  const tattle_score_speed_of_service = avgNonNull(
    surveys.map((s) => numOrNull(s.speed_of_service_score))
  );

  // ---- Customer review metrics (Google/Yelp/etc.) ----
  const { data: attributedReviews } = await supabase
    .from("review_attributions")
    .select("customer_reviews!inner(rating, review_date)")
    .eq("employee_id", employeeId)
    .gte("customer_reviews.review_date", periodStart)
    .lte("customer_reviews.review_date", periodEnd);

  type ReviewRollup = {
    rating: number | string | null;
  };
  const reviews = ((attributedReviews ?? []) as unknown as Array<{
    customer_reviews: ReviewRollup;
  }>)
    .map((r) => r.customer_reviews)
    .filter(Boolean);

  const customer_review_quantity = reviews.length;
  const customer_service_rating = avgNonNull(reviews.map((r) => numOrNull(r.rating)));

  // ---- Survey engagement (assignments whose survey.sent_date is in this quarter) ----
  const { data: surveyRows } = await supabase
    .from("survey_assignments")
    .select("completed, surveys!inner(sent_date)")
    .eq("employee_id", employeeId)
    .gte("surveys.sent_date", periodStart)
    .lte("surveys.sent_date", periodEnd);

  const assignments = (surveyRows ?? []) as unknown as Array<{
    completed: boolean;
    surveys: { sent_date: string | null };
  }>;
  const surveys_assigned = assignments.length;
  const surveys_completed = assignments.filter((a) => a.completed).length;
  const survey_engagement_pct =
    surveys_assigned > 0 ? (surveys_completed / surveys_assigned) * 100 : null;

  // ---- Task metrics ----
  // Pull every task this employee was accountable for, with each task's list,
  // date, and completion flag, restricted to the quarter window.
  type AcctRow = {
    tasks: {
      id: string;
      task_list_name: string;
      task_date: string;
      is_complete: boolean;
    } | null;
  };
  const { data: acctRows } = await supabase
    .from("task_accountability")
    .select("tasks!inner(id, task_list_name, task_date, is_complete)")
    .eq("employee_id", employeeId)
    .gte("tasks.task_date", periodStart)
    .lte("tasks.task_date", periodEnd);

  const accountableTasks = ((acctRows ?? []) as unknown as AcctRow[])
    .map((r) => r.tasks)
    .filter((t): t is NonNullable<typeof t> => Boolean(t));

  const tasks_accountable = accountableTasks.length;
  const tasks_completed_count = accountableTasks.filter((t) => t.is_complete).length;
  const task_completion_pct =
    tasks_accountable > 0 ? (tasks_completed_count / tasks_accountable) * 100 : null;

  // Tasks Owned: how many tasks the employee personally completed in this quarter,
  // independent of whether they were accountable.
  const { data: ownedRows } = await supabase
    .from("task_owners")
    .select("tasks!inner(task_date)")
    .eq("employee_id", employeeId)
    .gte("tasks.task_date", periodStart)
    .lte("tasks.task_date", periodEnd);
  const tasks_owned = (ownedRows ?? []).length;

  // Group accountable tasks by (list_name, date)
  const accountableLists = new Map<string, string[]>(); // key -> task_ids
  for (const t of accountableTasks) {
    const k = `${t.task_list_name.toLowerCase()}|${t.task_date}`;
    const list = accountableLists.get(k);
    if (list) list.push(t.id);
    else accountableLists.set(k, [t.id]);
  }

  let task_list_completion_pct: number | null = null;
  let avg_task_list_completion_pct: number | null = null;

  if (accountableLists.size > 0) {
    // Batched per-list completion math — pull every task at this location
    // whose date is in the accountable date set in ONE query and aggregate
    // in JS. See computeMetricsForRange for full rationale; this legacy
    // path mirrors that optimization so the quarterly-recompute throughput
    // matches.
    const accountableDates = new Set<string>();
    for (const k of accountableLists.keys()) {
      accountableDates.add(k.split("|")[1]);
    }

    const { data: allListTasks } = await supabase
      .from("tasks")
      .select("is_complete, task_list_name, task_date")
      .eq("location_id", locationId)
      .in("task_date", Array.from(accountableDates))
      .range(0, 99999);

    const groupCounts = new Map<string, { total: number; done: number }>();
    for (const t of allListTasks ?? []) {
      const listLower = (t.task_list_name as string).toLowerCase();
      const key = `${listLower}|${t.task_date as string}`;
      if (!accountableLists.has(key)) continue;
      const ex = groupCounts.get(key);
      if (!ex) {
        groupCounts.set(key, { total: 1, done: t.is_complete ? 1 : 0 });
      } else {
        ex.total += 1;
        if (t.is_complete) ex.done += 1;
      }
    }

    const completionByList: number[] = [];
    let listsAtHundred = 0;
    for (const { total, done } of groupCounts.values()) {
      if (total === 0) continue;
      completionByList.push((done / total) * 100);
      if (done === total) listsAtHundred += 1;
    }

    if (completionByList.length > 0) {
      task_list_completion_pct = (listsAtHundred / completionByList.length) * 100;
      avg_task_list_completion_pct =
        completionByList.reduce((a, b) => a + b, 0) / completionByList.length;
    }
  }

  // ---- POS tip metrics ----
  const tip = await fetchTipMetrics(
    supabase,
    employeeId,
    locationId,
    periodStart,
    periodEnd
  );

  // ---- Kitchen Speed (reported metric; not scored) ----
  const kitchen = await fetchKitchenMetrics(
    supabase,
    employeeId,
    locationId,
    periodStart,
    periodEnd
  );

  // ---- Customer Service Score (Phase 9) ----
  const csWeights = opts?.csWeights ?? (await fetchCustomerServiceWeights(supabase));
  const csBreakdown = computeCustomerServiceScoreBreakdown(
    tattle_rating,
    customer_service_rating,
    tip.tip_rate_delta_pp,
    csWeights
  );

  // ---- Total Impact Score (Phase 10) ----
  // Non-null CS Score already encodes "Phase 9 composite present"; that's the
  // semantic TIS wants for its 5-component count.
  const tisWeights = opts?.tisWeights ?? (await fetchTotalImpactWeights(supabase));
  const tisBreakdown = computeTotalImpactScoreBreakdown(
    csBreakdown.composite_score,
    metrics.attendance_pct,
    metrics.on_time_grace_pct,
    avg_task_list_completion_pct,
    survey_engagement_pct,
    tisWeights
  );

  // No-conjuring rule (§3): "every active employee at the location" includes
  // people with nothing in the period — two write paths have already minted
  // all-null rows that surprised their operator (the lever at NOLA, the
  // worked-time backfill at DTD). No existing row + no activity = no write.
  const { data: existingRow, error: existingError } = await supabase
    .from("performance_records")
    .select("id")
    .eq("employee_id", employeeId)
    .eq("report_period_id", reportPeriodId)
    .maybeSingle();
  if (existingError) {
    return { ok: false, error: `performance_records existence read: ${existingError.message}` };
  }
  // Floor-aware activity (mig 066): entries below the demarcation floor are
  // outside the measured window and must not conjure a row — an employee
  // whose only signals sit below the floor has no activity in the period.
  const floorValue = metricsStart;
  const scorableEntryCount =
    floorValue !== null
      ? entries.filter((e) => e.entry_date >= floorValue).length
      : entries.length;
  if (
    !existingRow &&
    !periodHasActivity({
      entry_count: scorableEntryCount,
      tattle_quantity,
      customer_review_quantity,
      surveys_assigned,
      tasks_accountable,
      tasks_owned,
      hours_worked: tip.hours_worked,
      kitchen_items: kitchen.kitchen_items,
    })
  ) {
    return { ok: true, metrics, action: "skipped_no_activity" };
  }

  const { error: upsertError } = await supabase
    .from("performance_records")
    .upsert(
      {
        employee_id: employeeId,
        location_id: locationId,
        report_period_id: reportPeriodId,
        attendance_pct: metrics.attendance_pct,
        on_time_pct: metrics.on_time_pct,
        on_time_grace_pct: metrics.on_time_grace_pct,
        covered_shifts: metrics.covered_shifts,
        // THQ wire item 1 (mig 083): the counts substantiate the pct.
        // Ruling 8 at the write boundary: an excluded non-puncher's counts
        // are not-computed — null, never 0 (the compute path's zeros are
        // internal placeholders, not facts).
        scheduled_count: punchesTimeClock ? metrics.scheduled_count : null,
        attended_count: punchesTimeClock ? metrics.attended_count : null,
        surveys_assigned: surveys_assigned > 0 ? surveys_assigned : null,
        surveys_completed: surveys_assigned > 0 ? surveys_completed : null,
        survey_engagement_pct,
        tasks_accountable: tasks_accountable > 0 ? tasks_accountable : null,
        tasks_completed: tasks_accountable > 0 ? tasks_completed_count : null,
        tasks_owned: tasks_owned > 0 ? tasks_owned : null,
        task_completion_pct,
        task_list_completion_pct,
        avg_task_list_completion_pct,
        tattle_quantity: tattle_quantity > 0 ? tattle_quantity : null,
        tattle_rating,
        tattle_score_food_quality,
        tattle_score_accuracy,
        tattle_score_speed_of_service,
        customer_review_quantity:
          customer_review_quantity > 0 ? customer_review_quantity : null,
        customer_service_rating,
        hours_worked: tip.hours_worked,
        sales_during_presence: tip.sales_during_presence,
        tips_during_presence: tip.tips_during_presence,
        tip_rate_pct: tip.tip_rate_pct,
        tip_per_hour: tip.tip_per_hour,
        location_tip_rate_pct: tip.location_tip_rate_pct,
        location_tip_per_hour: tip.location_tip_per_hour,
        tip_rate_delta_pp: tip.tip_rate_delta_pp,
        // kitchen_prep_delta_seconds (flat-average delta) is superseded by
        // kitchen_residual_seconds as of 043 and deliberately not written.
        // kitchen_baseline_prep_seconds is not persisted (= avg - residual).
        kitchen_items: kitchen.kitchen_items,
        kitchen_tickets: kitchen.kitchen_tickets,
        kitchen_shifts: kitchen.kitchen_shifts,
        kitchen_avg_prep_seconds: kitchen.kitchen_avg_prep_seconds,
        location_kitchen_avg_prep_seconds: kitchen.location_kitchen_avg_prep_seconds,
        kitchen_residual_seconds: kitchen.kitchen_residual_seconds,
        customer_service_score: csBreakdown.composite_score,
        customer_service_score_components_count: csBreakdown.components_count,
        total_impact_score: tisBreakdown.composite_score,
        total_impact_score_components_count: tisBreakdown.components_count,
      },
      { onConflict: "employee_id,report_period_id" }
    );

  if (upsertError) return { ok: false, error: upsertError.message };
  return { ok: true, metrics, action: existingRow ? "updated" : "created" };
}
