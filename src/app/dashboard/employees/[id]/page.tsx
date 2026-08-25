import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionRole } from "@/lib/authz";
import { Badge } from "@/components/ui/badge";
import { EmployeeStatusButton } from "@/components/employee/EmployeeStatusButton";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatHireDate, formatTenure, numOrNull, toNum } from "@/lib/format";
import {
  computeMetricsFromEntries,
  punchesTimeClockForPeriod,
} from "@/lib/performance-recompute";
import {
  PerformanceHistoryTabs,
  type QuarterRow,
} from "@/components/employee/PerformanceHistoryTabs";
import {
  CustomerServiceScoreCard,
  type CustomerServiceScoreQuarterRow,
} from "@/components/employee/CustomerServiceScoreCard";
import { fetchCustomerServiceWeights } from "@/lib/customer-service-score";
import { fetchMetricTargets } from "@/lib/metric-targets";
import { TotalImpactScoreCard } from "@/components/employee/TotalImpactScoreCard";
import {
  computeTotalImpactScoreBreakdown,
  fetchAllTimeWorkedHours,
  fetchTotalImpactWeights,
  isEligibleForRanking,
  TIS_ELIGIBILITY_MIN_HOURS,
} from "@/lib/total-impact-score";
import { generateTattleSummaryAction } from "./tattle-summary-actions";
import { generateTaskDetailReportAction } from "./generate-task-detail-actions";
import { generateCustomRangePerformanceReportAction } from "./generate-custom-range-actions";
import { updateManagerFeedbackAction } from "./manager-feedback-actions";
import { HourlyTipRateView } from "@/components/teams/HourlyTipRateView";
import { fetchMultiLocationProfile } from "@/lib/multi-location-fetch";
import { MultiLocationCard } from "@/components/employee/MultiLocationCard";
import type { HourlyTipRateRow } from "@/app/dashboard/locations/[id]/teams/fetch-hourly-tip-rate-actions";
// Server-safe module — importing these helpers from TimeWindowPicker (a
// "use client" file) makes them client references and calling one during the
// server render throws, killing the whole profile to an error/404 (Next 16).
import {
  resolveAllTimeWindow,
  resolveQuarterWindow,
  type QuarterOption,
  type TimeWindow,
} from "@/components/teams/time-window";

export default async function EmployeeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const search = await searchParams;
  const supabase = await createClient();
  const { role } = await getSessionRole();
  // §8-B ruling 2026-08-14: deactivate/reactivate extends to admin/manager
  // tiers; the server action re-checks tier + row scope.
  const canToggleStatus = role !== null && role !== "user";
  const rangeError =
    typeof search.range_error === "string" ? search.range_error : null;
  const rangeReportJustCreated =
    typeof search.range_report_id === "string" && search.range_report_id.length > 0
      ? search.range_report_id
      : null;
  const feedbackSavedFor =
    typeof search.feedback_saved === "string" ? search.feedback_saved : null;
  const feedbackError =
    typeof search.feedback_error === "string" ? search.feedback_error : null;

  const { data: emp } = await supabase
    .from("employees")
    .select(
      "id, employee_code, employee_name, email, phone, hire_date, wage, wage_pay_type, active, seven_shifts_user_id, punches_time_clock, punches_time_clock_since, is_general_manager, locations(id, name, clients(id, name))"
    )
    .eq("id", id)
    .single();
  if (!emp) notFound();

  const loc = emp.locations as unknown as
    | { id: string; name: string; clients: { id: string; name: string } | null }
    | null;
  const justSaved = search.saved === "1";

  // Multi-location combined view (§4-B): null for single-location people —
  // their profile renders exactly as before, no new chrome.
  const empSevenShiftsUserId =
    emp.seven_shifts_user_id === null || emp.seven_shifts_user_id === undefined
      ? null
      : Number(emp.seven_shifts_user_id);
  const multiLocation = await fetchMultiLocationProfile(
    supabase,
    emp.id,
    Number.isSafeInteger(empSevenShiftsUserId as number)
      ? (empSevenShiftsUserId as number)
      : null
  );

  // ---- Per-quarter records (from performance_records) ----
  const { data: records } = await supabase
    .from("performance_records")
    .select(
      "id, attendance_pct, on_time_pct, on_time_grace_pct, covered_shifts, surveys_assigned, surveys_completed, survey_engagement_pct, tasks_accountable, tasks_completed, tasks_owned, task_completion_pct, task_list_completion_pct, avg_task_list_completion_pct, tattle_quantity, tattle_rating, tattle_score_food_quality, tattle_score_accuracy, tattle_score_speed_of_service, customer_review_quantity, customer_service_rating, tip_rate_pct, tip_per_hour, location_tip_rate_pct, location_tip_per_hour, tip_rate_delta_pp, customer_service_score, customer_service_score_components_count, total_impact_score, total_impact_score_components_count, tattle_summary, tattle_summary_generated_at, manager_feedback, report_periods(id, label, period_start, period_end)"
    )
    .eq("employee_id", id);

  type RawPerfRow = {
    id: string;
    attendance_pct: number | string | null;
    on_time_pct: number | string | null;
    on_time_grace_pct: number | string | null;
    covered_shifts: number | null;
    surveys_assigned: number | null;
    surveys_completed: number | null;
    survey_engagement_pct: number | string | null;
    tasks_accountable: number | null;
    tasks_completed: number | null;
    tasks_owned: number | null;
    task_completion_pct: number | string | null;
    task_list_completion_pct: number | string | null;
    avg_task_list_completion_pct: number | string | null;
    tattle_quantity: number | null;
    tattle_rating: number | string | null;
    tattle_score_food_quality: number | string | null;
    tattle_score_accuracy: number | string | null;
    tattle_score_speed_of_service: number | string | null;
    customer_review_quantity: number | null;
    customer_service_rating: number | string | null;
    tip_rate_pct: number | string | null;
    tip_per_hour: number | string | null;
    location_tip_rate_pct: number | string | null;
    location_tip_per_hour: number | string | null;
    tip_rate_delta_pp: number | string | null;
    customer_service_score: number | string | null;
    customer_service_score_components_count: number | null;
    total_impact_score: number | string | null;
    total_impact_score_components_count: number | null;
    tattle_summary: string | null;
    tattle_summary_generated_at: string | null;
    manager_feedback: string | null;
    report_periods: { id: string; label: string; period_start: string; period_end: string } | null;
  };
  const rawRows = (records ?? []) as unknown as RawPerfRow[];
  rawRows.sort((a, b) =>
    (b.report_periods?.period_start ?? "").localeCompare(
      a.report_periods?.period_start ?? ""
    )
  );


  // Look up the current (non-superseded) generated_report per performance_record,
  // partitioned by report_kind ('performance' vs 'task_detail').
  const recordIds = rawRows.map((r) => r.id);
  const currentPerfByRecord = new Map<string, { id: string; flag: boolean }>();
  const taskDetailReportIdByRecord: Record<string, string> = {};
  if (recordIds.length > 0) {
    const { data: gr } = await supabase
      .from("generated_reports")
      .select(
        "id, performance_record_id, feedback_updated_after_generation, report_kind"
      )
      .in("performance_record_id", recordIds)
      .is("superseded_at", null);
    for (const row of gr ?? []) {
      const prId = row.performance_record_id as string | null;
      if (!prId) continue;
      const kind = (row.report_kind as string | null) ?? "performance";
      if (kind === "task_detail") {
        taskDetailReportIdByRecord[prId] = row.id as string;
      } else {
        currentPerfByRecord.set(prId, {
          id: row.id as string,
          flag: !!row.feedback_updated_after_generation,
        });
      }
    }
  }

  const byQuarter: QuarterRow[] = rawRows.map((r) => {
    const cur = currentPerfByRecord.get(r.id);
    return {
      id: r.id,
      label: r.report_periods?.label ?? "—",
      report_period_id: r.report_periods?.id ?? null,
      attendance_pct: numOrNull(r.attendance_pct),
      on_time_pct: numOrNull(r.on_time_pct),
      on_time_grace_pct: numOrNull(r.on_time_grace_pct),
      covered_shifts: r.covered_shifts,
      surveys_assigned: r.surveys_assigned,
      surveys_completed: r.surveys_completed,
      survey_engagement_pct: numOrNull(r.survey_engagement_pct),
      tasks_accountable: r.tasks_accountable,
      tasks_completed: r.tasks_completed,
      tasks_owned: r.tasks_owned,
      task_completion_pct: numOrNull(r.task_completion_pct),
      task_list_completion_pct: numOrNull(r.task_list_completion_pct),
      avg_task_list_completion_pct: numOrNull(r.avg_task_list_completion_pct),
      tattle_quantity: r.tattle_quantity,
      tattle_rating: numOrNull(r.tattle_rating),
      tattle_score_food_quality: numOrNull(r.tattle_score_food_quality),
      tattle_score_accuracy: numOrNull(r.tattle_score_accuracy),
      tattle_score_speed_of_service: numOrNull(r.tattle_score_speed_of_service),
      customer_review_quantity: r.customer_review_quantity,
      customer_service_rating: numOrNull(r.customer_service_rating),
      tip_rate_pct: numOrNull(r.tip_rate_pct),
      tip_per_hour: numOrNull(r.tip_per_hour),
      location_tip_rate_pct: numOrNull(r.location_tip_rate_pct),
      location_tip_per_hour: numOrNull(r.location_tip_per_hour),
      tip_rate_delta_pp: numOrNull(r.tip_rate_delta_pp),
      current_report_id: cur?.id ?? null,
      feedback_updated_after_generation: cur?.flag ?? false,
    };
  });

  // ---- Phase 9: CS Score quarter rows + weights for the tile ----
  const csScoreRows: CustomerServiceScoreQuarterRow[] = rawRows
    .filter((r) => r.report_periods !== null)
    .map((r) => ({
      performance_record_id: r.id,
      label: r.report_periods?.label ?? "—",
      period_start: r.report_periods?.period_start ?? "",
      customer_service_score: numOrNull(r.customer_service_score),
      customer_service_score_components_count:
        r.customer_service_score_components_count ?? null,
      tattle_rating: numOrNull(r.tattle_rating),
      tattle_quantity: r.tattle_quantity,
      customer_service_rating: numOrNull(r.customer_service_rating),
      customer_review_quantity: r.customer_review_quantity,
      tip_rate_delta_pp: numOrNull(r.tip_rate_delta_pp),
    }));
  const csWeights = await fetchCustomerServiceWeights(supabase);
  const metricTargets = await fetchMetricTargets(supabase);

  const tattleSummaryRows = rawRows
    .filter((r) => (r.tattle_quantity ?? 0) > 0)
    .map((r) => ({
      id: r.id,
      label: r.report_periods?.label ?? "—",
      summary: r.tattle_summary,
      generated_at: r.tattle_summary_generated_at,
    }));

  const feedbackRows = rawRows.map((r) => ({
    id: r.id,
    label: r.report_periods?.label ?? "—",
    manager_feedback: r.manager_feedback,
  }));

  // ---- All-time and last-14-days summaries (computed on demand from time_entries) ----
  const todayIso = new Date().toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 13); // inclusive 14-day window ending today
  const fourteenDaysAgoIso = fourteenDaysAgo.toISOString().slice(0, 10);

  const showAllReports = search.all_reports === "1";
  const [
    { data: allEntries },
    { data: recentEntries },
    { data: upcomingShiftRows },
    { data: workedShiftRows },
    { data: archiveRows },
  ] = await Promise.all([
    supabase
      .from("time_entries")
      .select("entry_date, entry_type, in_time")
      .eq("employee_id", id),
    supabase
      .from("time_entries")
      .select("entry_date, entry_type, in_time")
      .eq("employee_id", id)
      .gte("entry_date", fourteenDaysAgoIso)
      .lte("entry_date", todayIso),
    supabase
      .from("time_entries")
      .select("id, entry_date, in_time, out_time, role, regular_hours")
      .eq("employee_id", id)
      .eq("entry_type", "scheduled")
      .gte("entry_date", todayIso)
      .order("entry_date", { ascending: true })
      .limit(21),
    supabase
      .from("time_entries")
      .select("id, entry_date, in_time, out_time, role, regular_hours")
      .eq("employee_id", id)
      .eq("entry_type", "worked")
      .lte("entry_date", todayIso)
      .order("entry_date", { ascending: false })
      .limit(30),
    supabase
      .from("generated_reports")
      .select(
        "id, generation_mode, report_kind, custom_range, generated_at, superseded_at, feedback_updated_after_generation, report_periods(label)"
      )
      .eq("employee_id", id)
      .order("generated_at", { ascending: false })
      .limit(200),
  ]);
  type ShiftRow = {
    id: string;
    entry_date: string;
    in_time: string | null;
    out_time: string | null;
    role: string | null;
    regular_hours: number | string | null;
  };
  const upcomingShifts = (upcomingShiftRows ?? []) as ShiftRow[];
  const workedShifts = (workedShiftRows ?? []) as ShiftRow[];
  type ArchiveRow = {
    id: string;
    generation_mode: string;
    report_kind: string;
    custom_range: { start: string; end: string } | null;
    generated_at: string;
    superseded_at: string | null;
    feedback_updated_after_generation: boolean;
    report_periods: { label: string } | null;
  };
  const reportArchive = ((archiveRows ?? []) as unknown as ArchiveRow[]).filter(
    (r) => showAllReports || r.superseded_at === null
  );

  type EntryRow = { entry_date: string; entry_type: "scheduled" | "worked"; in_time: string | null };
  // Mig 056: a non-puncher's profile summaries read not-computable, not 0%
  // (Codex 2026-08-24 — this surface bypassed the recompute entry points).
  // Both summary windows end today, so the effective-date gate (§2a) uses
  // today as the period end.
  const punchesTimeClock = punchesTimeClockForPeriod(
    emp.punches_time_clock !== false,
    emp.punches_time_clock_since ?? null,
    new Date().toISOString().slice(0, 10)
  );
  const allTime = computeMetricsFromEntries((allEntries ?? []) as EntryRow[], {
    punchesTimeClock,
  });
  const last14Days = computeMetricsFromEntries((recentEntries ?? []) as EntryRow[], {
    punchesTimeClock,
  });

  // ---- Recent custom-range reports for this employee ----
  const { data: customRangeRows } = await supabase
    .from("generated_reports")
    .select("id, custom_range, generated_at")
    .eq("employee_id", id)
    .eq("generation_mode", "custom_range")
    .eq("report_kind", "performance")
    .is("superseded_at", null)
    .order("generated_at", { ascending: false })
    .limit(8);
  type CustomRangeRow = {
    id: string;
    custom_range: { start: string; end: string } | null;
    generated_at: string;
  };
  const customRangeReports = ((customRangeRows ?? []) as unknown as CustomRangeRow[]).map(
    (r) => ({
      id: r.id,
      start: r.custom_range?.start ?? "",
      end: r.custom_range?.end ?? "",
      generated_at: r.generated_at,
    })
  );

  // Default the date-range form to the last 30 days
  const todayDate = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
  const thirtyDaysAgoIso = thirtyDaysAgo.toISOString().slice(0, 10);

  // ---- Hourly tip rate card: initial data ----
  // Pull available quarters at the employee's location, earliest sales date,
  // and the SSR-prefetched hourly rows for the most-recent quarter so the
  // chart paints without a loading flash.
  let hourlyInitialRows: HourlyTipRateRow[] = [];
  let hourlyInitialWindow: TimeWindow | null = null;
  let hourlyQuarters: QuarterOption[] = [];
  let hourlyEarliest: string | null = null;
  let hourlyLatest: string | null = null;
  if (loc?.id) {
    const [{ data: teamPeriodsRes }, { data: perfPeriodsRes }, { data: salesRange }] =
      await Promise.all([
        supabase
          .from("team_tip_impact")
          .select("report_periods!inner(id, label, period_start, period_end)")
          .eq("location_id", loc.id),
        supabase
          .from("performance_records")
          .select("report_periods!inner(id, label, period_start, period_end)")
          .eq("location_id", loc.id),
        supabase
          .from("sales_records")
          .select("transaction_at")
          .eq("location_id", loc.id)
          .order("transaction_at", { ascending: true })
          .limit(1),
      ]);
    type QuarterRowShape = {
      report_periods: QuarterOption | null;
    };
    const seen = new Map<string, QuarterOption>();
    for (const row of (teamPeriodsRes ?? []) as unknown as QuarterRowShape[]) {
      if (row.report_periods) seen.set(row.report_periods.id, row.report_periods);
    }
    for (const row of (perfPeriodsRes ?? []) as unknown as QuarterRowShape[]) {
      if (row.report_periods) seen.set(row.report_periods.id, row.report_periods);
    }
    hourlyQuarters = Array.from(seen.values()).sort((a, b) =>
      b.period_start.localeCompare(a.period_start)
    );
    hourlyEarliest =
      ((salesRange?.[0] as { transaction_at: string } | undefined)?.transaction_at?.slice(0, 10)) ??
      null;
    hourlyLatest = todayDate;

    if (hourlyQuarters.length > 0) {
      hourlyInitialWindow = resolveQuarterWindow(hourlyQuarters[0]);
    } else if (hourlyEarliest) {
      hourlyInitialWindow = resolveAllTimeWindow(hourlyEarliest, hourlyLatest);
    }

    if (hourlyInitialWindow) {
      const { data: rpcData } = await supabase.rpc(
        "compute_employee_hourly_tip_rate",
        {
          p_employee_id: emp.id,
          p_location_id: loc.id,
          p_start_date: hourlyInitialWindow.startDate,
          p_end_date: hourlyInitialWindow.endDate,
        }
      );
      type RpcRow = {
        hour_of_day: number | string;
        employee_hours_worked: number | string | null;
        employee_sales: number | string | null;
        employee_tips: number | string | null;
        employee_tip_rate_pct: number | string | null;
        location_sales: number | string | null;
        location_tips: number | string | null;
        location_tip_rate_pct: number | string | null;
      };
      hourlyInitialRows = ((rpcData ?? []) as RpcRow[]).map((r) => ({
        hour_of_day: Number(r.hour_of_day),
        employee_hours_worked: toNum(r.employee_hours_worked),
        employee_sales: toNum(r.employee_sales),
        employee_tips: toNum(r.employee_tips),
        employee_tip_rate_pct: numOrNull(r.employee_tip_rate_pct),
        location_sales: toNum(r.location_sales),
        location_tips: toNum(r.location_tips),
        location_tip_rate_pct: numOrNull(r.location_tip_rate_pct),
      }));
    }
  }

  // ---- Phase 10: Total Impact Score initial state ----
  // Prefetch the most-recent quarter's snapshot + ranks so the tile paints
  // without a loading flash on first render. Eligibility is computed up front
  // (all-time hours + active flag) so the "Not eligible" annotation is
  // accurate without a follow-up roundtrip.
  const tisWeights = await fetchTotalImpactWeights(supabase);
  const tisQuarters: QuarterOption[] = rawRows
    .filter((r) => r.report_periods !== null)
    .map((r) => ({
      id: r.report_periods!.id,
      label: r.report_periods!.label,
      period_start: r.report_periods!.period_start,
      period_end: r.report_periods!.period_end,
    }));
  const allTimeHoursWorked = loc?.id
    ? await fetchAllTimeWorkedHours(supabase, emp.id, loc.id)
    : 0;
  const tisEligible = isEligibleForRanking(!!emp.active, allTimeHoursWorked);

  // Earliest worked entry — anchors "All time" mode for this employee.
  const { data: earliestEntryRow } = await supabase
    .from("time_entries")
    .select("entry_date")
    .eq("employee_id", emp.id)
    .order("entry_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  const tisEarliestDate =
    (earliestEntryRow?.entry_date as string | undefined) ?? null;

  let tisInitialWindow: TimeWindow | null = null;
  if (tisQuarters.length > 0) {
    tisInitialWindow = resolveQuarterWindow(tisQuarters[0]);
  } else if (tisEarliestDate) {
    tisInitialWindow = resolveAllTimeWindow(tisEarliestDate, todayDate);
  }

  // Initial snapshot: when the default window is a quarter, derive from the
  // already-fetched rawRows; otherwise leave null and let the client fetch.
  let tisInitialSnapshot: Awaited<
    ReturnType<typeof import("./fetch-tis-actions").fetchTisRangeSnapshotAction>
  > | null = null;
  let tisInitialRanks: Awaited<
    ReturnType<typeof import("./fetch-tis-actions").fetchTisRanksForEmployeeAction>
  > | null = null;

  if (tisInitialWindow && tisInitialWindow.mode === "quarter" && tisInitialWindow.quarterId && loc?.id) {
    const r0 = rawRows.find((r) => r.report_periods?.id === tisInitialWindow!.quarterId);
    const cs = numOrNull(r0?.customer_service_score ?? null);
    const att = numOrNull(r0?.attendance_pct ?? null);
    const on = numOrNull(r0?.on_time_grace_pct ?? null);
    const tasks = numOrNull(r0?.avg_task_list_completion_pct ?? null);
    const survey = numOrNull(r0?.survey_engagement_pct ?? null);
    const breakdown = computeTotalImpactScoreBreakdown(cs, att, on, tasks, survey, tisWeights);
    tisInitialSnapshot = {
      composite_score: breakdown.composite_score,
      components_count: breakdown.components_count,
      breakdown,
      cs_score: cs,
      cs_components_count: r0?.customer_service_score_components_count ?? null,
      attendance_pct: att,
      on_time_grace_pct: on,
      avg_task_list_completion_pct: tasks,
      survey_engagement_pct: survey,
      weights: tisWeights,
    };

    if (tisEligible) {
      const { data: rkRows } = await supabase.rpc(
        "compute_tis_rankings_for_quarter",
        { p_report_period_id: tisInitialWindow.quarterId }
      );
      type RankRow = {
        employee_id: string;
        location_rank: number | null;
        location_total: number;
        client_rank: number | null;
        client_total: number;
        platform_rank: number | null;
        platform_total: number;
      };
      const me = ((rkRows ?? []) as RankRow[]).find((r) => r.employee_id === emp.id);
      tisInitialRanks = {
        eligible: true,
        hours_worked: allTimeHoursWorked,
        hours_required: TIS_ELIGIBILITY_MIN_HOURS,
        location_rank: me?.location_rank ?? null,
        location_total: me?.location_total ?? 0,
        client_rank: me?.client_rank ?? null,
        client_total: me?.client_total ?? 0,
        platform_rank: me?.platform_rank ?? null,
        platform_total: me?.platform_total ?? 0,
      };
    } else {
      tisInitialRanks = {
        eligible: false,
        hours_worked: allTimeHoursWorked,
        hours_required: TIS_ELIGIBILITY_MIN_HOURS,
        location_rank: null,
        location_total: 0,
        client_rank: null,
        client_total: 0,
        platform_rank: null,
        platform_total: 0,
      };
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-slate-500">
          {loc && (
            <Link href={`/dashboard/locations/${loc.id}`} className="hover:underline">
              ← {loc.name}
            </Link>
          )}
        </p>
        <div className="flex items-start justify-between mt-1 gap-4">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold tracking-tight">{emp.employee_name}</h1>
            {emp.active ? (
              <Badge className="bg-ikes-green-dark text-white">Active</Badge>
            ) : (
              <Badge tone="muted">Inactive</Badge>
            )}
            {emp.is_general_manager === true && (
              <Badge tone="muted">General manager</Badge>
            )}
            {canToggleStatus && loc && (
              <EmployeeStatusButton
                employeeId={emp.id}
                locationId={loc.id}
                employeeName={emp.employee_name as string}
                active={!!emp.active}
                returnTo={`/dashboard/employees/${emp.id}`}
              />
            )}
          </div>
          <Button asChild>
            <Link href={`/dashboard/employees/${emp.id}/edit`}>Edit</Link>
          </Button>
        </div>
        {emp.is_general_manager === true && (
          <p className="text-xs text-slate-500 mt-1">
            GM punch patterns are expected to be irregular — offsite work and
            on-call time never reach a time clock. Their attendance still counts
            in store-wide numbers; the store view also reports an
            excluding-management figure alongside.
          </p>
        )}
      </div>

      {justSaved && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Changes saved.
        </div>
      )}

      {multiLocation && (
        <MultiLocationCard
          currentEmployeeId={emp.id}
          siblings={multiLocation.siblings}
          quarters={multiLocation.quarters.map((q) => ({
            id: q.id,
            label: q.label,
          }))}
          perLocationQuarter={multiLocation.perLocationQuarter}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="text-sm grid grid-cols-1 md:grid-cols-2 gap-y-2 gap-x-6">
            <div>
              <dt className="text-slate-500">Employee ID</dt>
              <dd className="font-mono">{emp.employee_code}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Location</dt>
              <dd>{loc?.name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Client</dt>
              <dd>{loc?.clients?.name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Status</dt>
              <dd>{emp.active ? "Active" : "Inactive"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Hire date</dt>
              <dd>{emp.hire_date ? formatHireDate(emp.hire_date) : "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Tenure</dt>
              <dd>{emp.hire_date ? formatTenure(emp.hire_date) : "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Wage</dt>
              <dd>
                {emp.wage !== null
                  ? `$${Number(emp.wage).toFixed(2)}${
                      emp.wage_pay_type ? ` ${emp.wage_pay_type.toLowerCase()}` : ""
                    }`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Email</dt>
              <dd>
                {emp.email ? (
                  <a href={`mailto:${emp.email}`} className="hover:underline">
                    {emp.email}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Phone</dt>
              <dd>
                {emp.phone ? (
                  <a href={`tel:${emp.phone.replace(/\D/g, "")}`} className="hover:underline">
                    {emp.phone}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {(() => {
        const cur = rawRows[0] ?? null;
        const label = cur?.report_periods?.label ?? null;
        const tiles: Array<{ name: string; value: string; n: string | null }> = cur
          ? [
              // Display name diverges from customer_service_rating
              // deliberately (2026-08-14 rename).
              {
                name: "Online Review Rating",
                value:
                  numOrNull(cur.customer_service_rating) !== null
                    ? `${Number(cur.customer_service_rating).toFixed(2)} / 5`
                    : "—",
                n:
                  cur.customer_review_quantity != null
                    ? `n=${cur.customer_review_quantity}`
                    : null,
              },
              {
                name: "Attendance",
                value:
                  numOrNull(cur.attendance_pct) !== null
                    ? `${Number(cur.attendance_pct).toFixed(1)}%`
                    : "—",
                n: null,
              },
              {
                name: "On-Time",
                value:
                  numOrNull(cur.on_time_grace_pct) !== null
                    ? `${Number(cur.on_time_grace_pct).toFixed(1)}%`
                    : "—",
                n: null,
              },
              {
                name: "Survey Engagement",
                value:
                  numOrNull(cur.survey_engagement_pct) !== null
                    ? `${Number(cur.survey_engagement_pct).toFixed(1)}%`
                    : "—",
                n:
                  cur.surveys_assigned != null
                    ? `n=${cur.surveys_assigned}`
                    : null,
              },
              {
                name: "7Tasks Completion",
                value:
                  numOrNull(cur.avg_task_list_completion_pct) !== null
                    ? `${Number(cur.avg_task_list_completion_pct).toFixed(1)}%`
                    : "—",
                n: null,
              },
              {
                name: "Tattle Rating",
                value:
                  numOrNull(cur.tattle_rating) !== null
                    ? `${Number(cur.tattle_rating).toFixed(2)} / 5`
                    : "—",
                n:
                  cur.tattle_quantity != null ? `n=${cur.tattle_quantity}` : null,
              },
            ]
          : [];
        if (tiles.length === 0) return null;
        return (
          <Card>
            <CardHeader>
              <CardTitle>
                Performance metrics{label ? ` — ${label}` : ""}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {tiles.map((t) => (
                  <div
                    key={t.name}
                    className="rounded-md border border-slate-200 px-3 py-2.5"
                  >
                    <p className="text-xs text-slate-500">{t.name}</p>
                    <p className="text-lg font-semibold mt-0.5">{t.value}</p>
                    {t.n && <p className="text-[11px] text-slate-400">{t.n}</p>}
                  </div>
                ))}
              </div>
              <p className="text-xs text-slate-400 mt-3">
                — means not computed for this quarter (never zero-filled).
              </p>
            </CardContent>
          </Card>
        );
      })()}

      <Card>
        <CardHeader>
          <CardTitle>Shifts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
                Upcoming scheduled
              </h3>
              {upcomingShifts.length === 0 ? (
                <p className="text-sm text-slate-500">No scheduled shifts on file.</p>
              ) : (
                <ul className="text-sm divide-y divide-slate-100">
                  {upcomingShifts.map((sh) => (
                    <li key={sh.id} className="py-1.5 flex justify-between gap-3">
                      <span>{sh.entry_date}</span>
                      <span className="text-slate-600">
                        {(sh.in_time ?? "—").slice(0, 5)}–{(sh.out_time ?? "—").slice(0, 5)}
                      </span>
                      <span className="text-slate-500 text-xs self-center">
                        {sh.role ?? ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
                Recent worked
              </h3>
              {workedShifts.length === 0 ? (
                <p className="text-sm text-slate-500">No worked shifts on file.</p>
              ) : (
                <ul className="text-sm divide-y divide-slate-100">
                  {workedShifts.map((sh) => (
                    <li key={sh.id} className="py-1.5 flex justify-between gap-3">
                      <span>{sh.entry_date}</span>
                      <span className="text-slate-600">
                        {(sh.in_time ?? "—").slice(0, 5)}–{(sh.out_time ?? "—").slice(0, 5)}
                      </span>
                      <span className="text-slate-500 text-xs self-center">
                        {sh.role ?? ""}
                        {sh.regular_hours != null && Number(sh.regular_hours) > 0
                          ? ` · ${Number(sh.regular_hours).toFixed(1)}h`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Performance history</CardTitle>
        </CardHeader>
        <CardContent>
          <PerformanceHistoryTabs
            byQuarter={byQuarter}
            last14Days={last14Days}
            allTime={allTime}
            targets={metricTargets}
            employeeId={emp.id}
            locationId={loc?.id ?? ""}
            canGenerate={role === "system_admin"}
            taskDetailReportIdByRecord={taskDetailReportIdByRecord}
          />
        </CardContent>
      </Card>

      {/* §4-E: quick 7Tasks-detail access without a trip through the builder.
          Generation is SA-gated like the builder; retrieval is for anyone who
          can see the profile. */}
      <Card>
        <CardHeader>
          <CardTitle>7Tasks detail reports</CardTitle>
        </CardHeader>
        <CardContent>
          {rawRows.filter((r) => r.report_periods !== null).length === 0 ? (
            <p className="text-sm text-slate-500">
              No quarterly records yet — 7Tasks detail is quarterly-only.
            </p>
          ) : (
            <ul className="space-y-2">
              {rawRows
                .filter((r) => r.report_periods !== null)
                .map((r) => {
                  const taskDetailId = taskDetailReportIdByRecord[r.id] ?? null;
                  return (
                    <li
                      key={r.id}
                      className="flex items-center gap-3 flex-wrap text-sm"
                    >
                      <span className="font-medium min-w-[90px]">
                        {r.report_periods?.label}
                      </span>
                      {taskDetailId && (
                        <a
                          href={`/api/reports/${taskDetailId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs underline hover:text-slate-900"
                        >
                          Download
                        </a>
                      )}
                      {role === "system_admin" && (
                        <form action={generateTaskDetailReportAction}>
                          <input
                            type="hidden"
                            name="performance_record_id"
                            value={r.id}
                          />
                          <input
                            type="hidden"
                            name="employee_id"
                            value={emp.id}
                          />
                          <SubmitButton
                            variant="outline"
                            size="sm"
                            pendingLabel="Generating…"
                          >
                            {taskDetailId ? "Regenerate" : "Generate"}
                          </SubmitButton>
                        </form>
                      )}
                    </li>
                  );
                })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Customer service score</CardTitle>
        </CardHeader>
        <CardContent>
          {csScoreRows.length === 0 ? (
            <p className="text-sm text-slate-500">
              No performance records yet. The composite tile will appear once
              underlying data (Tattle, reviews, POS) is ingested.
            </p>
          ) : (
            <CustomerServiceScoreCard quarters={csScoreRows} weights={csWeights} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Total impact score</CardTitle>
        </CardHeader>
        <CardContent>
          {!loc?.id || !tisInitialWindow || !tisInitialSnapshot || !tisInitialRanks ? (
            <p className="text-sm text-slate-500">
              No performance records yet. The composite tile will appear once
              the underlying data is ingested.
            </p>
          ) : (
            <TotalImpactScoreCard
              employeeId={emp.id}
              locationId={loc.id}
              quarters={tisQuarters}
              earliestDate={tisEarliestDate}
              latestDate={todayDate}
              initialWindow={tisInitialWindow}
              initialSnapshot={tisInitialSnapshot}
              initialRanks={tisInitialRanks}
              weights={tisWeights}
            />
          )}
        </CardContent>
      </Card>

      {loc?.id && hourlyInitialWindow && (
        <Card>
          <CardHeader>
            <CardTitle>Hourly tip rate</CardTitle>
          </CardHeader>
          <CardContent>
            <HourlyTipRateView
              employeeId={emp.id}
              employeeName={emp.employee_name as string}
              locationId={loc.id}
              initialRows={hourlyInitialRows}
              initialWindow={hourlyInitialWindow}
              quarters={hourlyQuarters}
              earliestDate={hourlyEarliest}
              latestDate={hourlyLatest}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Manager feedback</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500 mb-4">
            Write feedback for each quarter below. The feedback is included
            verbatim in the generated performance report. Editing feedback
            after a report has already been generated will mark that report
            as stale (you&apos;ll see a ⚠ next to it on the History tab).
          </p>

          {feedbackError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 mb-4">
              {feedbackError}
            </div>
          )}

          {feedbackRows.length === 0 ? (
            <p className="text-sm text-slate-500">
              No quarterly performance records yet.
            </p>
          ) : (
            <div className="space-y-4">
              {feedbackRows.map((r) => {
                const justSavedThis = feedbackSavedFor === r.id;
                return (
                  <details
                    key={r.id}
                    open={!r.manager_feedback || justSavedThis}
                    className="rounded-md border border-slate-200 bg-white"
                  >
                    <summary className="cursor-pointer select-none flex items-center justify-between px-4 py-2.5 text-sm">
                      <span className="font-medium">{r.label}</span>
                      <span className="text-xs text-slate-500">
                        {r.manager_feedback ? (
                          <>
                            {r.manager_feedback.length} chars
                            {justSavedThis && (
                              <span className="ml-2 text-emerald-700">
                                ✓ saved
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-amber-700">No feedback yet</span>
                        )}
                      </span>
                    </summary>
                    <div className="border-t border-slate-200 px-4 py-3">
                      <form
                        action={updateManagerFeedbackAction}
                        className="space-y-2"
                      >
                        <input
                          type="hidden"
                          name="performance_record_id"
                          value={r.id}
                        />
                        <input
                          type="hidden"
                          name="employee_id"
                          value={emp.id}
                        />
                        <textarea
                          name="manager_feedback"
                          defaultValue={r.manager_feedback ?? ""}
                          rows={5}
                          placeholder={`Feedback for ${r.label}…`}
                          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-sans focus:border-slate-500 focus:outline-none"
                        />
                        <div className="flex justify-end">
                          <SubmitButton
                            variant="outline"
                            size="sm"
                            pendingLabel="Saving…"
                          >
                            Save feedback
                          </SubmitButton>
                        </div>
                      </form>
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card id="reports">
        <CardHeader>
          <CardTitle>Reports</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-slate-500">
              Every report generated for this employee. Quarterly generation
              lives on the History tab above; custom ranges below.
            </p>
            <Link
              href={
                showAllReports
                  ? `/dashboard/employees/${emp.id}#reports`
                  : `/dashboard/employees/${emp.id}?all_reports=1#reports`
              }
              className="text-xs text-ikes-blue underline-offset-2 hover:underline whitespace-nowrap"
            >
              {showAllReports ? "Current only" : "Include superseded"}
            </Link>
          </div>
          {reportArchive.length === 0 ? (
            <p className="text-sm text-slate-500">No reports generated yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-500 uppercase border-b border-slate-200">
                  <tr>
                    <th className="py-2 pr-4">Generated</th>
                    <th className="py-2 pr-4">Period</th>
                    <th className="py-2 pr-4">Mode</th>
                    <th className="py-2 pr-4">Kind</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {reportArchive.map((r) => (
                    <tr key={r.id}>
                      <td className="py-2 pr-4 whitespace-nowrap">
                        {new Date(r.generated_at).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap">
                        {r.generation_mode === "custom_range" && r.custom_range
                          ? `${r.custom_range.start} → ${r.custom_range.end}`
                          : (r.report_periods?.label ?? "—")}
                      </td>
                      <td className="py-2 pr-4 text-xs text-slate-600">
                        {r.generation_mode === "custom_range" ? "Custom" : "Quarterly"}
                      </td>
                      <td className="py-2 pr-4 text-xs text-slate-600">
                        {r.report_kind === "task_detail" ? "Task detail" : "Performance"}
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap text-xs">
                        {r.superseded_at ? (
                          <span className="text-slate-500">Superseded</span>
                        ) : r.feedback_updated_after_generation ? (
                          <span
                            className="text-amber-700"
                            title="Manager feedback was updated after this report was generated."
                          >
                            ⚠ Stale
                          </span>
                        ) : (
                          <span className="text-emerald-700">Current</span>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        <a
                          href={`/api/reports/${r.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs underline hover:text-slate-900"
                        >
                          View
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Custom date range report</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500 mb-4">
            Generate a performance report over an arbitrary date range. Metrics
            are recomputed from raw data for the window you choose; manager
            feedback is taken from the most recent overlapping quarter.
          </p>

          {rangeError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 mb-4">
              {rangeError}
            </div>
          )}

          {rangeReportJustCreated && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 mb-4 flex items-center justify-between">
              <span>Custom-range report generated.</span>
              <a
                href={`/api/reports/${rangeReportJustCreated}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-emerald-950"
              >
                Download
              </a>
            </div>
          )}

          <form
            action={generateCustomRangePerformanceReportAction}
            className="flex flex-wrap items-end gap-3"
          >
            <input type="hidden" name="employee_id" value={emp.id} />
            <div>
              <label className="block text-xs text-slate-500 mb-1">
                Start date
              </label>
              <input
                type="date"
                name="range_start"
                defaultValue={thirtyDaysAgoIso}
                required
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">
                End date
              </label>
              <input
                type="date"
                name="range_end"
                defaultValue={todayDate}
                required
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <SubmitButton variant="outline" size="sm" pendingLabel="Generating…">
              Generate report
            </SubmitButton>
          </form>

          {customRangeReports.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold mb-2">Recent custom-range reports</h3>
              <ul className="text-sm divide-y divide-slate-100 border border-slate-200 rounded-md">
                {customRangeReports.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between px-3 py-2"
                  >
                    <div>
                      <span className="font-medium">
                        {r.start} → {r.end}
                      </span>
                      <span className="text-xs text-slate-500 ml-3">
                        Generated {new Date(r.generated_at).toLocaleString()}
                      </span>
                    </div>
                    <a
                      href={`/api/reports/${r.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs underline hover:text-slate-900"
                    >
                      Download
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tattle summaries</CardTitle>
        </CardHeader>
        <CardContent>
          {tattleSummaryRows.length === 0 ? (
            <p className="text-sm text-slate-500">
              No tattle surveys attributed to this employee yet. Upload tattle data on the
              location page to populate.
            </p>
          ) : (
            <div className="space-y-4">
              {tattleSummaryRows.map((r) => (
                <div
                  key={r.id}
                  className="rounded-md border border-slate-200 bg-white px-4 py-3"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">{r.label}</h3>
                    <form action={generateTattleSummaryAction}>
                      <input type="hidden" name="employee_id" value={emp.id} />
                      <input type="hidden" name="performance_record_id" value={r.id} />
                      <SubmitButton
                        variant="outline"
                        size="sm"
                        pendingLabel="Asking Claude…"
                      >
                        {r.summary ? "Regenerate" : "Generate summary"}
                      </SubmitButton>
                    </form>
                  </div>
                  {r.summary ? (
                    <div className="mt-2">
                      <p className="text-sm whitespace-pre-wrap text-slate-700">
                        {r.summary}
                      </p>
                      {r.generated_at && (
                        <p className="text-xs text-slate-400 mt-2">
                          Generated {new Date(r.generated_at).toLocaleString()}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500 mt-2">
                      Click Generate to produce an AI summary from the tattle comments
                      attributed to this employee in {r.label}.
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
