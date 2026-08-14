"use client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge, ExpectationBadge } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/submit-button";
import { classifyVsTarget, type MetricTargets } from "@/lib/classify";
import type { TargetLabel, TargetMetricKey } from "@/lib/types";
import {
  formatDeltaPP,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatRating,
} from "@/lib/format";

/** Neutral band around the location tip-rate average (percentage points). */
const TIP_DELTA_NEUTRAL_PP = 0.25;

export interface MetricsSummary {
  attendance_pct: number | null;
  on_time_pct: number | null;
  on_time_grace_pct: number | null;
  covered_shifts: number;
  scheduled_count: number;
  attended_count: number;
  missed_count: number;
}

export interface QuarterRow {
  id: string;
  label: string;
  attendance_pct: number | null;
  on_time_pct: number | null;
  on_time_grace_pct: number | null;
  covered_shifts: number | null;
  surveys_assigned: number | null;
  surveys_completed: number | null;
  survey_engagement_pct: number | null;
  tasks_accountable: number | null;
  tasks_completed: number | null;
  tasks_owned: number | null;
  task_completion_pct: number | null;
  task_list_completion_pct: number | null;
  avg_task_list_completion_pct: number | null;
  tattle_quantity: number | null;
  tattle_rating: number | null;
  tattle_score_food_quality: number | null;
  tattle_score_accuracy: number | null;
  tattle_score_speed_of_service: number | null;
  customer_review_quantity: number | null;
  customer_service_rating: number | null;
  // POS tip metrics — null if no sales data for this period
  tip_rate_pct: number | null;
  tip_per_hour: number | null;
  location_tip_rate_pct: number | null;
  location_tip_per_hour: number | null;
  tip_rate_delta_pp: number | null;
  current_report_id: string | null;
  feedback_updated_after_generation: boolean;
}

export interface PerformanceTabsProps {
  byQuarter: QuarterRow[];
  last14Days: MetricsSummary;
  allTime: MetricsSummary;
  /** metric_targets rows (mig 051), loaded server-side by the page. */
  targets: MetricTargets;
  employeeId: string;
  generateAction: (formData: FormData) => Promise<void>;
  generateTaskDetailAction: (formData: FormData) => Promise<void>;
  taskDetailReportIdByRecord: Record<string, string>;
}

export function PerformanceHistoryTabs({
  byQuarter,
  last14Days,
  allTime,
  targets,
  employeeId,
  generateAction,
  generateTaskDetailAction,
  taskDetailReportIdByRecord,
}: PerformanceTabsProps) {
  return (
    <Tabs defaultValue="quarterly" className="w-full">
      <TabsList>
        <TabsTrigger value="quarterly">By quarter</TabsTrigger>
        <TabsTrigger value="recent">Last 14 days</TabsTrigger>
        <TabsTrigger value="alltime">All-time</TabsTrigger>
      </TabsList>

      <TabsContent value="quarterly">
        {byQuarter.length === 0 ? (
          <p className="text-sm text-slate-500">
            No performance records yet. Upload time data on the location page to populate.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500 uppercase border-b border-slate-200">
                <tr>
                  <th className="py-2 pr-4">Period</th>
                  <th className="py-2 pr-4">Attendance</th>
                  <th className="py-2 pr-4">On time (no grace)</th>
                  <th className="py-2 pr-4">On time (3-min grace)</th>
                  <th className="py-2 pr-4">Covered shifts</th>
                  <th className="py-2 pr-4">Surveys sent</th>
                  <th className="py-2 pr-4">Surveys completed</th>
                  <th className="py-2 pr-4">Survey engagement</th>
                  <th className="py-2 pr-4">Tasks acct.</th>
                  <th className="py-2 pr-4">Tasks owned</th>
                  <th className="py-2 pr-4">Task compl. %</th>
                  <th className="py-2 pr-4">Task-list compl. %</th>
                  <th className="py-2 pr-4">Avg task-list rate</th>
                  <th className="py-2 pr-4">Tattle qty</th>
                  <th className="py-2 pr-4">Tattle rating</th>
                  <th className="py-2 pr-4">Food quality</th>
                  <th className="py-2 pr-4">Accuracy</th>
                  <th className="py-2 pr-4">Speed</th>
                  <th className="py-2 pr-4">Reviews</th>
                  {/* Display name diverges from the customer_service_rating
                      column name deliberately (2026-08-14 rename). */}
                  <th className="py-2 pr-4">Online review rating</th>
                  <th className="py-2 pr-4">Tip rate</th>
                  <th className="py-2 pr-4">Tip / hr</th>
                  <th className="py-2 pr-4">vs Loc avg</th>
                  <th className="py-2 pr-4">Report</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {byQuarter.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 pr-4 font-medium">{r.label}</td>
                    <MetricCell value={r.attendance_pct} metric="attendance_pct" targets={targets} />
                    {/* Strict (no-grace) on-time is context only — the target
                        evaluates the grace variant, the displayed/wire value
                        (2026-08-14 sprint, Tucker decision). */}
                    <td className="py-2 pr-4">{formatPercent(r.on_time_pct)}</td>
                    <MetricCell value={r.on_time_grace_pct} metric="on_time_grace_pct" targets={targets} />
                    <td className="py-2 pr-4">{formatQuantity(r.covered_shifts)}</td>
                    <td className="py-2 pr-4">{formatQuantity(r.surveys_assigned)}</td>
                    <td className="py-2 pr-4">{formatQuantity(r.surveys_completed)}</td>
                    <MetricCell value={r.survey_engagement_pct} metric="survey_engagement_pct" targets={targets} />
                    <td className="py-2 pr-4">{formatQuantity(r.tasks_accountable)}</td>
                    <td className="py-2 pr-4">{formatQuantity(r.tasks_owned)}</td>
                    <td className="py-2 pr-4">{formatPercent(r.task_completion_pct)}</td>
                    <td className="py-2 pr-4">{formatPercent(r.task_list_completion_pct)}</td>
                    {/* Newly classified with the targets sprint — the ninth
                        target metric (previously rendered without a badge). */}
                    <MetricCell value={r.avg_task_list_completion_pct} metric="avg_task_list_completion_pct" targets={targets} />
                    <td className="py-2 pr-4">{formatQuantity(r.tattle_quantity)}</td>
                    <MetricCell value={r.tattle_rating} metric="tattle_rating" kind="rating" targets={targets} />
                    <MetricCell value={r.tattle_score_food_quality} metric="tattle_score_food_quality" kind="rating" targets={targets} />
                    <MetricCell value={r.tattle_score_accuracy} metric="tattle_score_accuracy" kind="rating" targets={targets} />
                    <MetricCell value={r.tattle_score_speed_of_service} metric="tattle_score_speed_of_service" kind="rating" targets={targets} />
                    <td className="py-2 pr-4">{formatQuantity(r.customer_review_quantity)}</td>
                    <MetricCell value={r.customer_service_rating} metric="customer_service_rating" kind="rating" targets={targets} />
                    <td className="py-2 pr-4">{formatPercent(r.tip_rate_pct)}</td>
                    <td className="py-2 pr-4">{formatMoney(r.tip_per_hour)}</td>
                    <td className="py-2 pr-4">
                      <TipBadge
                        deltaPp={r.tip_rate_delta_pp}
                        locationRatePct={r.location_tip_rate_pct}
                        employeeRatePct={r.tip_rate_pct}
                      />
                    </td>
                    <td className="py-2 pr-4">
                      <ReportCell
                        row={r}
                        employeeId={employeeId}
                        generateAction={generateAction}
                        generateTaskDetailAction={generateTaskDetailAction}
                        taskDetailReportId={taskDetailReportIdByRecord[r.id] ?? null}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </TabsContent>

      <TabsContent value="recent">
        <SummaryView label="Last 14 days" metrics={last14Days} targets={targets} />
      </TabsContent>

      <TabsContent value="alltime">
        <SummaryView label="All time" metrics={allTime} targets={targets} />
      </TabsContent>
    </Tabs>
  );
}

function MetricCell({
  value,
  metric,
  targets,
  kind = "pct",
}: {
  value: number | null;
  metric: TargetMetricKey;
  targets: MetricTargets;
  kind?: "pct" | "rating";
}) {
  const label =
    value !== null ? classifyVsTarget(metric, Number(value), targets) : null;
  const display = kind === "rating" ? formatRating(value) : formatPercent(value);
  return (
    <td className="py-2 pr-4">
      <div className="flex items-center gap-2">
        <span>{display}</span>
        <ExpectationBadge label={label} />
      </div>
    </td>
  );
}

/**
 * Tip-rate delta badge.
 *
 *   delta_pp > +0.25  →  green up arrow   (employee lifts the location tip rate)
 *   delta_pp < -0.25  →  red down arrow   (employee drags the location tip rate)
 *   otherwise         →  yellow flat      (within the noise band)
 *   delta_pp is null  →  em dash          (no sales data for this period)
 *
 * Tooltip shows the underlying numbers so a manager can sanity-check.
 */
function TipBadge({
  deltaPp,
  locationRatePct,
  employeeRatePct,
}: {
  deltaPp: number | null;
  locationRatePct: number | null;
  employeeRatePct: number | null;
}) {
  if (deltaPp === null) return <span className="text-slate-400">—</span>;
  const tone =
    deltaPp > TIP_DELTA_NEUTRAL_PP
      ? "exceeds"
      : deltaPp < -TIP_DELTA_NEUTRAL_PP
        ? "below"
        : "meets";
  const arrow =
    tone === "exceeds" ? "↑" : tone === "below" ? "↓" : "→";
  const title =
    `Employee: ${formatPercent(employeeRatePct)}  ·  ` +
    `Location: ${formatPercent(locationRatePct)}  ·  ` +
    `Δ ${formatDeltaPP(deltaPp)}`;
  return (
    <Badge tone={tone} title={title}>
      <span aria-hidden>{arrow}</span>
      <span className="ml-1 tabular-nums">{formatDeltaPP(deltaPp)}</span>
    </Badge>
  );
}

function SummaryView({
  label,
  metrics,
  targets,
}: {
  label: string;
  metrics: MetricsSummary;
  targets: MetricTargets;
}) {
  if (metrics.scheduled_count === 0 && metrics.covered_shifts === 0) {
    return (
      <p className="text-sm text-slate-500">
        No time entries in this window.
      </p>
    );
  }

  const attLabel = classifyVsTarget(
    "attendance_pct",
    metrics.attendance_pct,
    targets
  );
  // Strict (no-grace) on-time is context only — the target evaluates the
  // grace variant, the displayed/wire value (2026-08-14 sprint).
  const otGraceLabel = classifyVsTarget(
    "on_time_grace_pct",
    metrics.on_time_grace_pct,
    targets
  );

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        {label} · {metrics.scheduled_count} scheduled shift{metrics.scheduled_count === 1 ? "" : "s"} ·{" "}
        {metrics.attended_count} attended · {metrics.missed_count} missed ·{" "}
        {metrics.covered_shifts} covered
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Tile title="Attendance" value={metrics.attendance_pct} label={attLabel} kind="pct" />
        <Tile title="Covered shifts" value={metrics.covered_shifts} label={null} kind="count" />
        <Tile title="On time (no grace)" value={metrics.on_time_pct} label={null} kind="pct" />
        <Tile title="On time (3-min grace)" value={metrics.on_time_grace_pct} label={otGraceLabel} kind="pct" />
      </div>
    </div>
  );
}

function ReportCell({
  row,
  employeeId,
  generateAction,
  generateTaskDetailAction,
  taskDetailReportId,
}: {
  row: QuarterRow;
  employeeId: string;
  generateAction: (formData: FormData) => Promise<void>;
  generateTaskDetailAction: (formData: FormData) => Promise<void>;
  taskDetailReportId: string | null;
}) {
  return (
    <div className="flex flex-col gap-1.5 min-w-[260px]">
      {/* Performance report row */}
      <div className="flex items-center gap-2 flex-wrap">
        {row.current_report_id && (
          <a
            href={`/api/reports/${row.current_report_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs underline hover:text-slate-900"
          >
            Download
          </a>
        )}
        <form action={generateAction} className="flex items-center gap-2 flex-wrap">
          <input type="hidden" name="performance_record_id" value={row.id} />
          <input type="hidden" name="employee_id" value={employeeId} />
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <input
              type="checkbox"
              name="include_task_detail"
              value="1"
              className="h-3 w-3"
            />
            +Task detail
          </label>
          <SubmitButton variant="outline" size="sm" pendingLabel="Generating…">
            {row.current_report_id ? "Regenerate" : "Generate"}
          </SubmitButton>
        </form>
        {row.feedback_updated_after_generation && row.current_report_id && (
          <span
            className="text-xs text-amber-700"
            title="Manager feedback was updated after this report was generated."
          >
            ⚠ stale
          </span>
        )}
      </div>

      {/* Task Detail standalone row */}
      <div className="flex items-center gap-2 flex-wrap">
        {taskDetailReportId && (
          <a
            href={`/api/reports/${taskDetailReportId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs underline hover:text-slate-900"
          >
            Download Task Detail
          </a>
        )}
        <form action={generateTaskDetailAction}>
          <input type="hidden" name="performance_record_id" value={row.id} />
          <input type="hidden" name="employee_id" value={employeeId} />
          <SubmitButton
            variant="outline"
            size="sm"
            pendingLabel="Generating…"
          >
            {taskDetailReportId ? "Regenerate Task Detail" : "Generate Task Detail"}
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}

function Tile({
  title,
  value,
  label,
  kind,
}: {
  title: string;
  value: number | null;
  label: TargetLabel | null;
  kind: "pct" | "count";
}) {
  const display =
    kind === "pct" ? formatPercent(value) : formatQuantity(value);
  return (
    <div className="rounded-md border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs text-slate-500">{title}</p>
      <div className="flex items-center gap-2 mt-1">
        <p className="text-2xl font-semibold tracking-tight">{display}</p>
        {label && <ExpectationBadge label={label} />}
      </div>
    </div>
  );
}
