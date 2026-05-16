"use client";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  TimeWindowPicker,
  type QuarterOption,
  type TimeWindow,
} from "@/components/teams/TimeWindowPicker";
import {
  classifyTotalImpactScore,
  formatTotalImpactScore,
  toneForTotalImpactScore,
  TIS_ELIGIBILITY_MIN_HOURS,
  type TisScoreTone,
  type TotalImpactWeights,
} from "@/lib/total-impact-score";
import {
  fetchTisRangeSnapshotAction,
  fetchTisRanksForEmployeeAction,
  type TisRangeSnapshot,
  type TisRanks,
} from "@/app/dashboard/employees/[id]/fetch-tis-actions";
import { formatPercent } from "@/lib/format";

interface Props {
  employeeId: string;
  locationId: string;
  quarters: QuarterOption[];
  earliestDate: string | null;
  latestDate: string | null;
  initialWindow: TimeWindow;
  initialSnapshot: TisRangeSnapshot;
  initialRanks: TisRanks;
  weights: TotalImpactWeights;
}

/**
 * Total Impact Score tile + drilldown for the employee detail page.
 *
 * Quarter mode reads from persisted performance_records via a server action;
 * non-quarter modes recompute the snapshot on demand by reusing
 * computeMetricsForRange. Three ranks (location / client / platform) render
 * compactly under the composite. Ineligible employees still get the composite
 * + drilldown but render "Not eligible (X of 40 hours)" in place of ranks.
 */
export function TotalImpactScoreCard({
  employeeId,
  locationId,
  quarters,
  earliestDate,
  latestDate,
  initialWindow,
  initialSnapshot,
  initialRanks,
  weights,
}: Props) {
  const [window, setWindow] = useState<TimeWindow>(initialWindow);
  const [snapshot, setSnapshot] = useState<TisRangeSnapshot>(initialSnapshot);
  const [ranks, setRanks] = useState<TisRanks>(initialRanks);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Stash the initial window's identity so the effect only fires when the
  // user actually changes the window. JSON.stringify is fine here — the
  // window is a tiny object and this triggers ~once per click.
  const windowKey = useMemo(
    () =>
      `${window.mode}|${window.startDate}|${window.endDate}|${window.quarterId ?? ""}`,
    [window]
  );
  const initialKey = useMemo(
    () =>
      `${initialWindow.mode}|${initialWindow.startDate}|${initialWindow.endDate}|${initialWindow.quarterId ?? ""}`,
    [initialWindow]
  );

  useEffect(() => {
    if (windowKey === initialKey) return; // SSR data is correct for this window
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    Promise.all([
      fetchTisRangeSnapshotAction(
        employeeId,
        locationId,
        window.mode,
        window.startDate,
        window.endDate,
        window.quarterId
      ),
      fetchTisRanksForEmployeeAction(
        employeeId,
        locationId,
        window.mode,
        window.startDate,
        window.endDate,
        window.quarterId
      ),
    ])
      .then(([snap, rk]) => {
        if (cancelled) return;
        setSnapshot(snap);
        setRanks(rk);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [windowKey, initialKey, employeeId, locationId, window]);

  const composite = snapshot.composite_score;
  const tone = toneForTotalImpactScore(composite);
  const label = classifyTotalImpactScore(composite);
  const cnt = snapshot.components_count;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <TimeWindowPicker
          quarters={quarters}
          earliestDate={earliestDate}
          latestDate={latestDate}
          value={window}
          onChange={setWindow}
        />
        <p className="text-xs text-slate-500">
          Weights: CS {Math.round(weights.weight_cs_score * 100)}% · Att{" "}
          {Math.round(weights.weight_attendance * 100)}% · On-time{" "}
          {Math.round(weights.weight_on_time * 100)}% · Tasks{" "}
          {Math.round(weights.weight_tasks * 100)}% · Survey{" "}
          {Math.round(weights.weight_survey * 100)}%
        </p>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`w-full text-left rounded-md border ${
          tone === "green"
            ? "border-emerald-200 bg-emerald-50"
            : tone === "yellow"
              ? "border-amber-200 bg-amber-50"
              : tone === "red"
                ? "border-red-200 bg-red-50"
                : "border-slate-200 bg-slate-50"
        } px-4 py-4 hover:shadow-sm transition-shadow ${
          loading ? "opacity-70" : ""
        }`}
        aria-expanded={expanded}
      >
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">
              Total Impact Score · {window.label}
            </p>
            <div className="flex items-baseline gap-3 mt-1">
              {composite !== null ? (
                <>
                  <span className="text-4xl font-semibold tabular-nums">
                    {formatTotalImpactScore(composite)}
                  </span>
                  <span className="text-slate-500 text-sm">/ 100</span>
                  {label && (
                    <Badge
                      tone={
                        label === "Exceeds Expectations"
                          ? "exceeds"
                          : label === "Meets Expectations"
                            ? "meets"
                            : "below"
                      }
                    >
                      {label === "Exceeds Expectations"
                        ? "Green ≥85"
                        : label === "Meets Expectations"
                          ? "Yellow 70–<85"
                          : "Red <70"}
                    </Badge>
                  )}
                </>
              ) : (
                <>
                  <span className="text-4xl font-semibold tabular-nums text-slate-400">
                    —
                  </span>
                  <span
                    className="text-xs text-slate-500"
                    title="Need at least 4 of 5 components present to produce a composite."
                  >
                    Insufficient data ({cnt} of 5 components)
                  </span>
                </>
              )}
            </div>
            {composite !== null && cnt === 4 && (
              <p className="text-xs text-slate-600 mt-1.5">
                Computed from 4 of 5 components (one missing — re-weighted pro-rata).
              </p>
            )}
            <div className="mt-2 text-xs text-slate-700">
              {ranks.eligible && composite !== null ? (
                <RanksLine ranks={ranks} />
              ) : !ranks.eligible ? (
                <span className="text-amber-700">
                  Not eligible for ranking ({Math.round(ranks.hours_worked)} of{" "}
                  {ranks.hours_required} all-time hours)
                </span>
              ) : (
                <span className="text-slate-500">Not ranked this range</span>
              )}
            </div>
          </div>
          <span className="text-xs text-slate-500">
            {loading
              ? "Loading…"
              : expanded
                ? "Hide breakdown ▴"
                : "Show breakdown ▾"}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="rounded-md border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-2">
            <p className="text-xs text-slate-500 uppercase tracking-wide">
              Component breakdown · {window.label}
            </p>
          </div>
          <ComponentRow
            name="Customer Service Score"
            extra={
              snapshot.cs_components_count !== null
                ? `${snapshot.cs_components_count} of 3 CS components present`
                : "—"
            }
            nativeDisplay={
              snapshot.cs_score !== null ? formatTotalImpactScore(snapshot.cs_score) : "—"
            }
            score={snapshot.breakdown.cs_component_score}
            configuredWeight={weights.weight_cs_score}
            effectiveWeight={snapshot.breakdown.effective_weight_cs}
            compositeComputed={composite !== null}
          />
          <ComponentRow
            name="Attendance"
            extra="Scheduled shifts attended"
            nativeDisplay={formatPercent(snapshot.attendance_pct)}
            score={snapshot.breakdown.attendance_component_score}
            configuredWeight={weights.weight_attendance}
            effectiveWeight={snapshot.breakdown.effective_weight_attendance}
            compositeComputed={composite !== null}
          />
          <ComponentRow
            name="On-time (3-min grace)"
            extra="Shifts clocked in within grace"
            nativeDisplay={formatPercent(snapshot.on_time_grace_pct)}
            score={snapshot.breakdown.on_time_component_score}
            configuredWeight={weights.weight_on_time}
            effectiveWeight={snapshot.breakdown.effective_weight_on_time}
            compositeComputed={composite !== null}
          />
          <ComponentRow
            name="Task completion"
            extra="Avg task-list completion %"
            nativeDisplay={formatPercent(snapshot.avg_task_list_completion_pct)}
            score={snapshot.breakdown.tasks_component_score}
            configuredWeight={weights.weight_tasks}
            effectiveWeight={snapshot.breakdown.effective_weight_tasks}
            compositeComputed={composite !== null}
          />
          <ComponentRow
            name="Survey engagement"
            extra="Completed / assigned (7taps)"
            nativeDisplay={formatPercent(snapshot.survey_engagement_pct)}
            score={snapshot.breakdown.survey_component_score}
            configuredWeight={weights.weight_survey}
            effectiveWeight={snapshot.breakdown.effective_weight_survey}
            compositeComputed={composite !== null}
            isLast
          />
          <div className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
            All five components are already on a 0–100 scale. Composite uses
            the configured weights above, re-weighted pro-rata when one
            component is missing (≥4 of 5 required). Badges follow the same
            cutoffs as the composite: Green ≥85, Yellow 70–&lt;85, Red &lt;70.
            Ranks are computed on-demand over the chosen range and are never
            stored. Eligibility for ranking requires Active = true AND at
            least {TIS_ELIGIBILITY_MIN_HOURS} all-time worked hours at this
            location.
          </div>
        </div>
      )}
    </div>
  );
}

function RanksLine({ ranks }: { ranks: TisRanks }) {
  const fmt = (rank: number | null, total: number) =>
    rank !== null && total > 0 ? `${rank} of ${total}` : "—";
  return (
    <span className="tabular-nums">
      Loc <strong>{fmt(ranks.location_rank, ranks.location_total)}</strong>
      <span className="text-slate-400"> · </span>
      Client <strong>{fmt(ranks.client_rank, ranks.client_total)}</strong>
      <span className="text-slate-400"> · </span>
      Platform <strong>{fmt(ranks.platform_rank, ranks.platform_total)}</strong>
    </span>
  );
}

function ComponentRow({
  name,
  nativeDisplay,
  extra,
  score,
  effectiveWeight,
  configuredWeight,
  compositeComputed,
  isLast,
}: {
  name: string;
  nativeDisplay: string;
  extra: string;
  score: number | null;
  effectiveWeight: number | null;
  configuredWeight: number;
  compositeComputed: boolean;
  isLast?: boolean;
}) {
  const tone = toneForTotalImpactScore(score);
  return (
    <div
      className={`grid grid-cols-[1.5fr,1fr,1fr,1.4fr] gap-3 px-4 py-3 items-center text-sm ${
        isLast ? "" : "border-b border-slate-100"
      }`}
    >
      <div>
        <p className="font-medium">{name}</p>
        <p className="text-xs text-slate-500">{extra}</p>
      </div>
      <div>
        <p className="text-xs text-slate-500">Native</p>
        <p className="font-medium tabular-nums">{nativeDisplay}</p>
      </div>
      <div>
        <p className="text-xs text-slate-500">0–100</p>
        <div className="flex items-center gap-2">
          <span className="font-semibold tabular-nums">
            {formatTotalImpactScore(score)}
          </span>
          <ToneDot tone={tone} />
        </div>
      </div>
      <div>
        <p className="text-xs text-slate-500">Weight (configured → effective)</p>
        <p className="text-sm tabular-nums">
          {(configuredWeight * 100).toFixed(0)}%
          <span className="text-slate-400 mx-1.5">→</span>
          {compositeComputed && effectiveWeight !== null && score !== null
            ? `${(effectiveWeight * 100).toFixed(1)}%`
            : score === null
              ? "—"
              : "n/a"}
        </p>
      </div>
    </div>
  );
}

function ToneDot({ tone }: { tone: TisScoreTone }) {
  const cls =
    tone === "green"
      ? "bg-emerald-500"
      : tone === "yellow"
        ? "bg-amber-500"
        : tone === "red"
          ? "bg-red-500"
          : "bg-slate-300";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} />;
}
