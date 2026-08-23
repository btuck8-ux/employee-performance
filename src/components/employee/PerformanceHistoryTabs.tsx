"use client";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge, ExpectationBadge } from "@/components/ui/badge";
import { classifyVsTarget, type MetricTargets } from "@/lib/classify";
import type { TargetLabel, TargetMetricKey } from "@/lib/types";
import {
  formatDeltaPP,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatRating,
} from "@/lib/format";
import {
  tipPerHourDeltaLabel,
  tipPerHourTone,
  tipRateDeltaLabel,
  tipRateTone,
} from "@/lib/tip-badges";

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
  /** For the §5-A builder prefill link; null for a period-less record. */
  report_period_id: string | null;
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
  /** For the §5-A builder prefill link (builder_location param). */
  locationId: string;
  /**
   * §5-A: performance-report generation is builder-only now, and the builder
   * is SA-gated — the row link renders only when the session can actually
   * use it (the page passes role === "system_admin").
   */
  canGenerate: boolean;
  taskDetailReportIdByRecord: Record<string, string>;
}

export function PerformanceHistoryTabs({
  byQuarter,
  last14Days,
  allTime,
  targets,
  employeeId,
  locationId,
  canGenerate,
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
                  <th className="py-2 pr-4">Rate vs store</th>
                  <th className="py-2 pr-4">$/hr vs store</th>
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
                      <TipPerHourBadge
                        tipPerHour={r.tip_per_hour}
                        locationTipPerHour={r.location_tip_per_hour}
                      />
                    </td>
                    <td className="py-2 pr-4">
                      <ReportCell
                        row={r}
                        employeeId={employeeId}
                        locationId={locationId}
                        canGenerate={canGenerate}
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
 * Tip-rate delta badge — §5-E dollar framing (2026-08-19). The visible label
 * is the exact conversion "35¢ per $100 sold below store average" (tip rate =
 * tips ÷ sales, so pp × 100 IS cents per $100 sold); the raw employee %,
 * location %, and Δpp stay in the tooltip. Copy + tone bands live in
 * src/lib/tip-badges.ts, shared with the PDF so the two can't drift.
 *
 *   delta_pp > +0.25  →  green up arrow   (employee lifts the location tip rate)
 *   delta_pp < -0.25  →  red down arrow   (employee drags the location tip rate)
 *   otherwise         →  yellow flat      (within the noise band)
 *   delta_pp is null  →  em dash          (no sales data for this period)
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
  const tone = tipRateTone(deltaPp);
  const arrow =
    tone === "exceeds" ? "↑" : tone === "below" ? "↓" : "→";
  const title =
    `Employee: ${formatPercent(employeeRatePct)}  ·  ` +
    `Location: ${formatPercent(locationRatePct)}  ·  ` +
    `Δ ${formatDeltaPP(deltaPp)}`;
  return (
    <Badge tone={tone} title={title}>
      <span aria-hidden>{arrow}</span>
      <span className="ml-1">{tipRateDeltaLabel(deltaPp)}</span>
    </Badge>
  );
}

/**
 * Tip/Hour vs-store badge (§2c scope addition, Tucker-approved): the dollar
 * gap between the employee's tips-per-hour and the location's, from two
 * columns already on performance_records. Neutral band ±$0.25/hr
 * (TIP_PER_HOUR_NEUTRAL_USD — delegated micro-call, see tip-badges.ts).
 * Either side null → em dash, matching the rate badge's convention.
 */
function TipPerHourBadge({
  tipPerHour,
  locationTipPerHour,
}: {
  tipPerHour: number | null;
  locationTipPerHour: number | null;
}) {
  if (tipPerHour === null || locationTipPerHour === null)
    return <span className="text-slate-400">—</span>;
  const delta = tipPerHour - locationTipPerHour;
  const tone = tipPerHourTone(delta);
  const arrow =
    tone === "exceeds" ? "↑" : tone === "below" ? "↓" : "→";
  const title =
    `Employee: ${formatMoney(tipPerHour)}/hr  ·  ` +
    `Location: ${formatMoney(locationTipPerHour)}/hr  ·  ` +
    `Δ ${formatMoney(delta)}/hr`;
  return (
    <Badge tone={tone} title={title}>
      <span aria-hidden>{arrow}</span>
      <span className="ml-1">{tipPerHourDeltaLabel(delta)}</span>
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

/**
 * §4-E (2026-08-23): FULLY CONSOLIDATED. Both generate controls are gone —
 * the single "Go to Report Builder" link carries the prefill (location +
 * employee + quarter), and the 7tasks detail is a report type inside the
 * builder's content picker. Retrieval stays row-level: Download, Download
 * Task Detail, and the ⚠ stale indicator. The profile's 7Tasks card keeps a
 * quick generate path that skips the builder trip.
 */
function ReportCell({
  row,
  employeeId,
  locationId,
  canGenerate,
  taskDetailReportId,
}: {
  row: QuarterRow;
  employeeId: string;
  locationId: string;
  canGenerate: boolean;
  taskDetailReportId: string | null;
}) {
  const builderHref =
    `/dashboard/reports?builder_location=${locationId}` +
    `&builder_employee=${employeeId}` +
    (row.report_period_id ? `&builder_period=${row.report_period_id}` : "");
  return (
    <div className="flex flex-col gap-1.5 min-w-[220px]">
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
        {row.feedback_updated_after_generation && row.current_report_id && (
          <span
            className="text-xs text-amber-700"
            title="Manager feedback was updated after this report was generated."
          >
            ⚠ stale
          </span>
        )}
      </div>
      {canGenerate && (
        <Link
          href={builderHref}
          className="text-xs text-ikes-blue underline-offset-2 hover:underline"
        >
          Go to Report Builder →
        </Link>
      )}
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
