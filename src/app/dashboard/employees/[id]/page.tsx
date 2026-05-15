import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatHireDate, formatTenure } from "@/lib/format";
import { computeMetricsFromEntries } from "@/lib/performance-recompute";
import {
  PerformanceHistoryTabs,
  type QuarterRow,
} from "@/components/employee/PerformanceHistoryTabs";
import { generateTattleSummaryAction } from "./tattle-summary-actions";
import { generatePerformanceReportAction } from "./generate-report-actions";
import { generateTaskDetailReportAction } from "./generate-task-detail-actions";
import { generateCustomRangePerformanceReportAction } from "./generate-custom-range-actions";
import { updateManagerFeedbackAction } from "./manager-feedback-actions";

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
      "id, employee_code, employee_name, email, phone, hire_date, wage, wage_pay_type, active, locations(id, name, clients(id, name))"
    )
    .eq("id", id)
    .single();
  if (!emp) notFound();

  const loc = emp.locations as unknown as
    | { id: string; name: string; clients: { id: string; name: string } | null }
    | null;
  const justSaved = search.saved === "1";

  // ---- Per-quarter records (from performance_records) ----
  const { data: records } = await supabase
    .from("performance_records")
    .select(
      "id, attendance_pct, on_time_pct, on_time_grace_pct, covered_shifts, surveys_assigned, surveys_completed, survey_engagement_pct, tasks_accountable, tasks_completed, tasks_owned, task_completion_pct, task_list_completion_pct, avg_task_list_completion_pct, tattle_quantity, tattle_rating, tattle_score_food_quality, tattle_score_accuracy, tattle_score_speed_of_service, customer_review_quantity, customer_service_rating, tip_rate_pct, tip_per_hour, location_tip_rate_pct, location_tip_per_hour, tip_rate_delta_pp, tattle_summary, tattle_summary_generated_at, manager_feedback, report_periods(label, period_start, period_end)"
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
    tattle_summary: string | null;
    tattle_summary_generated_at: string | null;
    manager_feedback: string | null;
    report_periods: { label: string; period_start: string; period_end: string } | null;
  };
  const rawRows = (records ?? []) as unknown as RawPerfRow[];
  rawRows.sort((a, b) =>
    (b.report_periods?.period_start ?? "").localeCompare(
      a.report_periods?.period_start ?? ""
    )
  );

  const toNumOrNull = (v: number | string | null): number | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === "string" ? Number(v) : v;
    return Number.isNaN(n) ? null : n;
  };

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
      attendance_pct: toNumOrNull(r.attendance_pct),
      on_time_pct: toNumOrNull(r.on_time_pct),
      on_time_grace_pct: toNumOrNull(r.on_time_grace_pct),
      covered_shifts: r.covered_shifts,
      surveys_assigned: r.surveys_assigned,
      surveys_completed: r.surveys_completed,
      survey_engagement_pct: toNumOrNull(r.survey_engagement_pct),
      tasks_accountable: r.tasks_accountable,
      tasks_completed: r.tasks_completed,
      tasks_owned: r.tasks_owned,
      task_completion_pct: toNumOrNull(r.task_completion_pct),
      task_list_completion_pct: toNumOrNull(r.task_list_completion_pct),
      avg_task_list_completion_pct: toNumOrNull(r.avg_task_list_completion_pct),
      tattle_quantity: r.tattle_quantity,
      tattle_rating: toNumOrNull(r.tattle_rating),
      tattle_score_food_quality: toNumOrNull(r.tattle_score_food_quality),
      tattle_score_accuracy: toNumOrNull(r.tattle_score_accuracy),
      tattle_score_speed_of_service: toNumOrNull(r.tattle_score_speed_of_service),
      customer_review_quantity: r.customer_review_quantity,
      customer_service_rating: toNumOrNull(r.customer_service_rating),
      tip_rate_pct: toNumOrNull(r.tip_rate_pct),
      tip_per_hour: toNumOrNull(r.tip_per_hour),
      location_tip_rate_pct: toNumOrNull(r.location_tip_rate_pct),
      location_tip_per_hour: toNumOrNull(r.location_tip_per_hour),
      tip_rate_delta_pp: toNumOrNull(r.tip_rate_delta_pp),
      current_report_id: cur?.id ?? null,
      feedback_updated_after_generation: cur?.flag ?? false,
    };
  });

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

  const [{ data: allEntries }, { data: recentEntries }] = await Promise.all([
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
  ]);

  type EntryRow = { entry_date: string; entry_type: "scheduled" | "worked"; in_time: string | null };
  const allTime = computeMetricsFromEntries((allEntries ?? []) as EntryRow[]);
  const last14Days = computeMetricsFromEntries((recentEntries ?? []) as EntryRow[]);

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
          <h1 className="text-2xl font-semibold tracking-tight">{emp.employee_name}</h1>
          <Button asChild>
            <Link href={`/dashboard/employees/${emp.id}/edit`}>Edit</Link>
          </Button>
        </div>
      </div>

      {justSaved && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Changes saved.
        </div>
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

      <Card>
        <CardHeader>
          <CardTitle>Performance history</CardTitle>
        </CardHeader>
        <CardContent>
          <PerformanceHistoryTabs
            byQuarter={byQuarter}
            last14Days={last14Days}
            allTime={allTime}
            employeeId={emp.id}
            generateAction={generatePerformanceReportAction}
            generateTaskDetailAction={generateTaskDetailReportAction}
            taskDetailReportIdByRecord={taskDetailReportIdByRecord}
          />
        </CardContent>
      </Card>

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
