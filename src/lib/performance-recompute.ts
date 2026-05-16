import type { SupabaseClient } from "@supabase/supabase-js";
import { quarterInfo, type Quarter } from "./quarter";
import {
  computeCustomerServiceScoreBreakdown,
  fetchCustomerServiceWeights,
  type CustomerServiceScoreBreakdown,
  type CustomerServiceWeights,
} from "./customer-service-score";

interface TimeEntryRow {
  entry_date: string;
  entry_type: "scheduled" | "worked";
  in_time: string | null;
}

/** Punctuality grace period in minutes — late if punch-in is more than this past scheduled. */
export const ON_TIME_GRACE_MINUTES = 3;

export interface PerformanceMetrics {
  attendance_pct: number | null;     // 0-100, null if no scheduled shifts
  on_time_pct: number | null;        // strict: actual_in <= scheduled_in
  on_time_grace_pct: number | null;  // with 3-minute grace period
  covered_shifts: number;
  scheduled_count: number;
  attended_count: number;
  missed_count: number;
  on_time_count: number;
  on_time_grace_count: number;
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
 */
export function computeMetricsFromEntries(
  entries: TimeEntryRow[],
  opts?: { scheduledScoredThrough?: string }
): PerformanceMetrics {
  const cap =
    opts?.scheduledScoredThrough ?? new Date().toISOString().slice(0, 10);

  const scheduledByDate = new Map<string, TimeEntryRow>();
  const workedByDate = new Map<string, TimeEntryRow>();

  for (const e of entries) {
    if (e.entry_type === "scheduled") scheduledByDate.set(e.entry_date, e);
    else workedByDate.set(e.entry_date, e);
  }

  let attended = 0;
  let missed = 0;
  let onTime = 0;
  let onTimeGrace = 0;

  for (const [date, sched] of scheduledByDate) {
    if (date > cap) continue; // future / not-yet-confirmed; don't score
    const worked = workedByDate.get(date);
    if (!worked) {
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
  for (const date of workedByDate.keys()) {
    if (!scheduledByDate.has(date)) covered += 1;
  }

  const scheduledCount = attended + missed;
  const attendance_pct = scheduledCount > 0 ? (attended / scheduledCount) * 100 : null;
  const on_time_pct = attended > 0 ? (onTime / attended) * 100 : null;
  const on_time_grace_pct = attended > 0 ? (onTimeGrace / attended) * 100 : null;

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
  // POS tips (presence-based; null when no sales data exists for the window)
  hours_worked: number | null;
  sales_during_presence: number | null;
  tips_during_presence: number | null;
  tip_rate_pct: number | null;
  tip_per_hour: number | null;
  location_tip_rate_pct: number | null;
  location_tip_per_hour: number | null;
  tip_rate_delta_pp: number | null;
  // Phase 9 — Customer Service Score (composite). Null composite when fewer
  // than 2 of 3 components are present. Per-component scores + effective
  // weights are kept in `customer_service_score_breakdown` so the dashboard
  // drill-down and PDF breakdown render without re-deriving the math.
  customer_service_score: number | null;
  customer_service_score_components_count: number;
  customer_service_score_breakdown: CustomerServiceScoreBreakdown;
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

  const toNum = (v: number | string | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === "string" ? Number(v) : v;
    return Number.isNaN(n) ? null : n;
  };

  // If both employee and location have zero qualifying sales, treat tips as
  // unavailable for the window — the function still returns 0 totals but
  // there's no meaningful metric to display.
  const employeeSales = toNum(row.sales_under_cap) ?? 0;
  const locationRate = toNum(row.location_avg_tip_rate_pct);
  if (employeeSales === 0 && locationRate === null) return nullTips;

  return {
    hours_worked: toNum(row.hours_worked),
    sales_during_presence: toNum(row.sales_under_cap),
    tips_during_presence: toNum(row.tips_under_cap),
    tip_rate_pct: toNum(row.employee_tip_rate_pct),
    tip_per_hour: toNum(row.employee_tip_per_hour),
    location_tip_rate_pct: toNum(row.location_avg_tip_rate_pct),
    location_tip_per_hour: toNum(row.location_avg_tip_per_hour),
    tip_rate_delta_pp: toNum(row.tip_rate_delta_pp),
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
  opts?: { csWeights?: CustomerServiceWeights }
): Promise<{ ok: true; metrics: RangeMetrics } | { ok: false; error: string }> {
  const { data: entries, error } = await supabase
    .from("time_entries")
    .select("entry_date, entry_type, in_time")
    .eq("employee_id", employeeId)
    .gte("entry_date", periodStart)
    .lte("entry_date", periodEnd);

  if (error) return { ok: false, error: error.message };

  // Cap attendance scoring at min(today, latest worked at this location).
  // This stops future-scheduled shifts from being counted as "missed" when
  // the schedule is uploaded ahead of time, and also handles the case where
  // worked CSVs lag behind scheduled CSVs.
  const todayIso = new Date().toISOString().slice(0, 10);
  const { data: latestWorked } = await supabase
    .from("time_entries")
    .select("entry_date")
    .eq("location_id", locationId)
    .eq("entry_type", "worked")
    .order("entry_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const latestWorkedDate = (latestWorked?.entry_date as string | undefined) ?? todayIso;
  const scheduledScoredThrough =
    latestWorkedDate < todayIso ? latestWorkedDate : todayIso;

  const shift = computeMetricsFromEntries(
    (entries ?? []) as TimeEntryRow[],
    { scheduledScoredThrough }
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

  // ---- Customer Service Score (Phase 9) ----
  const csWeights = opts?.csWeights ?? (await fetchCustomerServiceWeights(supabase));
  const csBreakdown = computeCustomerServiceScoreBreakdown(
    tattle_rating,
    customer_service_rating,
    tip.tip_rate_delta_pp,
    csWeights
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
      customer_service_score: csBreakdown.composite_score,
      customer_service_score_components_count: csBreakdown.components_count,
      customer_service_score_breakdown: csBreakdown,
    },
  };
}

/**
 * Recompute and upsert the performance_records row for one (employee, quarter).
 * Pulls all time_entries for the employee within the quarter window and writes
 * attendance_pct, on_time_pct, on_time_grace_pct, covered_shifts. Other metric
 * columns are left untouched if the row exists.
 */
export async function recomputePerformanceForQuarter(
  supabase: SupabaseClient,
  employeeId: string,
  locationId: string,
  year: number,
  quarter: Quarter,
  opts?: { csWeights?: CustomerServiceWeights }
): Promise<{ ok: true; metrics: PerformanceMetrics } | { ok: false; error: string }> {
  const q = quarterInfo(year, quarter);
  const periodStart = q.periodStart.toISOString().slice(0, 10);
  const periodEnd = q.periodEnd.toISOString().slice(0, 10);

  const { data: period } = await supabase
    .from("report_periods")
    .select("id")
    .eq("year", year)
    .eq("quarter", quarter)
    .maybeSingle();

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

  const { data: entries, error } = await supabase
    .from("time_entries")
    .select("entry_date, entry_type, in_time")
    .eq("employee_id", employeeId)
    .gte("entry_date", periodStart)
    .lte("entry_date", periodEnd);

  if (error) return { ok: false, error: error.message };

  // Cap attendance scoring at min(today, latest worked at this location) — see
  // computeMetricsForRange for the rationale.
  const todayIso = new Date().toISOString().slice(0, 10);
  const { data: latestWorked } = await supabase
    .from("time_entries")
    .select("entry_date")
    .eq("location_id", locationId)
    .eq("entry_type", "worked")
    .order("entry_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const latestWorkedDate = (latestWorked?.entry_date as string | undefined) ?? todayIso;
  const scheduledScoredThrough =
    latestWorkedDate < todayIso ? latestWorkedDate : todayIso;

  const metrics = computeMetricsFromEntries(
    (entries ?? []) as TimeEntryRow[],
    { scheduledScoredThrough }
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

  // ---- Customer Service Score (Phase 9) ----
  const csWeights = opts?.csWeights ?? (await fetchCustomerServiceWeights(supabase));
  const csBreakdown = computeCustomerServiceScoreBreakdown(
    tattle_rating,
    customer_service_rating,
    tip.tip_rate_delta_pp,
    csWeights
  );

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
        customer_service_score: csBreakdown.composite_score,
        customer_service_score_components_count: csBreakdown.components_count,
      },
      { onConflict: "employee_id,report_period_id" }
    );

  if (upsertError) return { ok: false, error: upsertError.message };
  return { ok: true, metrics };
}
