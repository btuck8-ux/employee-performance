"use client";
import { useEffect, useMemo, useState } from "react";
import {
  fetchCohortTimelineAction,
  type CohortDailyRow,
} from "@/app/dashboard/locations/[id]/teams/fetch-cohort-timeline-actions";
import {
  formatDeltaPP,
  formatMoney,
  formatPercent,
} from "@/lib/format";

interface CohortTimelineModalProps {
  open: boolean;
  onClose: () => void;
  memberIds: string[];
  memberNames: string[];
  locationId: string;
  startDate: string;
  endDate: string;
  /** Shown in the header (e.g., "Q1 2026"). */
  windowLabel: string;
  /** Headline-level summary for the modal header. */
  summary: {
    hoursTogether: number;
    salesDuring: number;
    tipRatePct: number | null;
    deltaVsLocPp: number | null;
  };
}

const COLORS = {
  cohort: "#0F766E",   // teal-700
  location: "#64748B", // slate-500
};

/** Centered moving average — averages over [i-r, i+r] for each point. */
function rollingAvg(
  values: Array<number | null>,
  radius: number
): Array<number | null> {
  if (radius <= 0) return values;
  const out: Array<number | null> = [];
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      const v = values[j];
      if (v !== null && !Number.isNaN(v)) {
        sum += v;
        count += 1;
      }
    }
    out.push(count > 0 ? sum / count : null);
  }
  return out;
}

export function CohortTimelineModal({
  open,
  onClose,
  memberIds,
  memberNames,
  locationId,
  startDate,
  endDate,
  windowLabel,
  summary,
}: CohortTimelineModalProps) {
  const [rows, setRows] = useState<CohortDailyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [smooth, setSmooth] = useState(true);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Reset state before kicking off the fetch. The lint rule discourages
    // setState in effects, but this is a legitimate "trigger an async load
    // when the modal opens / cohort changes" pattern — no external store
    // to subscribe to.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    setRows([]);
    fetchCohortTimelineAction({
      member_ids: memberIds,
      location_id: locationId,
      start_date: startDate,
      end_date: endDate,
    })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setRows(res.rows);
        else setError(res.error);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, memberIds, locationId, startDate, endDate]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const raw = useMemo(
    () => ({
      cohort: rows.map((r) => r.cohort_tip_rate_pct),
      location: rows.map((r) => r.location_tip_rate_pct),
    }),
    [rows]
  );

  const series = useMemo(() => {
    if (!smooth) return raw;
    return {
      cohort: rollingAvg(raw.cohort, 3),
      location: rollingAvg(raw.location, 3),
    };
  }, [raw, smooth]);

  const yMax = useMemo(() => {
    const all = [...series.cohort, ...series.location].filter(
      (v): v is number => v !== null
    );
    if (all.length === 0) return 10;
    return Math.max(1, Math.max(...all) * 1.1);
  }, [series]);

  if (!open) return null;

  const W = 880;
  const H = 360;
  const M = { top: 24, right: 24, bottom: 50, left: 48 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;

  const xToPx = (i: number) =>
    M.left + (rows.length <= 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);
  const yToPx = (y: number) => M.top + innerH - (y / yMax) * innerH;

  const tickStep = yMax > 10 ? 2 : yMax > 4 ? 1 : 0.5;
  const yTicks: number[] = [];
  for (let v = 0; v <= yMax + 1e-9; v += tickStep) {
    yTicks.push(Math.round(v * 100) / 100);
  }

  // Build polylines — null breaks the line
  function buildPath(values: Array<number | null>): string[] {
    const segs: string[] = [];
    let cur: string[] = [];
    values.forEach((v, i) => {
      if (v === null) {
        if (cur.length > 1) segs.push(cur.join(" "));
        cur = [];
      } else {
        cur.push(`${xToPx(i)},${yToPx(v)}`);
      }
    });
    if (cur.length > 1) segs.push(cur.join(" "));
    return segs;
  }
  const cohortSegs = buildPath(series.cohort);
  const locSegs = buildPath(series.location);

  // Date axis ticks: show ~6 evenly-spaced labels
  const xTickEvery = rows.length <= 7 ? 1 : Math.max(1, Math.floor(rows.length / 6));

  const hovered = hoverIdx !== null ? rows[hoverIdx] : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-5xl rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">
              Team timeline · {windowLabel}
            </p>
            <h2 className="text-lg font-semibold text-slate-900 mt-0.5">
              {memberNames.join(" × ")}
            </h2>
            <div className="flex flex-wrap gap-x-5 gap-y-0.5 text-xs text-slate-600 mt-1.5">
              <span>
                <span className="text-slate-500">Hours together: </span>
                {summary.hoursTogether.toFixed(1)}
              </span>
              <span>
                <span className="text-slate-500">Sales during co-presence: </span>
                {formatMoney(summary.salesDuring)}
              </span>
              <span>
                <span className="text-slate-500">Tip rate: </span>
                {formatPercent(summary.tipRatePct)}
              </span>
              <span>
                <span className="text-slate-500">Δ vs location: </span>
                {formatDeltaPP(summary.deltaVsLocPp)}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            Close
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              Solid = cohort tip rate that day. Dashed = location average for
              the same day. Days the cohort wasn&apos;t co-shifted are gaps in
              the cohort line.
            </p>
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={smooth}
                onChange={(e) => setSmooth(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              7-day smoothing
            </label>
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              Could not load timeline: {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-[360px] text-sm text-slate-500">
              Loading timeline…
            </div>
          ) : rows.length === 0 ? (
            <div className="flex items-center justify-center h-[360px] text-sm text-slate-500">
              No data for this cohort in {windowLabel}.
            </div>
          ) : (
            <>
              <svg
                viewBox={`0 0 ${W} ${H}`}
                className="w-full h-auto"
                role="img"
                aria-label="Cohort timeline chart"
              >
                <rect
                  x={M.left}
                  y={M.top}
                  width={innerW}
                  height={innerH}
                  fill="#FAFAFB"
                  stroke="#E2E8F0"
                />
                {yTicks.map((t) => (
                  <g key={`y-${t}`}>
                    <line
                      x1={M.left}
                      x2={M.left + innerW}
                      y1={yToPx(t)}
                      y2={yToPx(t)}
                      stroke="#E2E8F0"
                      strokeWidth={0.5}
                    />
                    <text
                      x={M.left - 6}
                      y={yToPx(t)}
                      textAnchor="end"
                      dominantBaseline="central"
                      fontSize={10}
                      fill="#64748B"
                    >
                      {t.toFixed(yMax > 4 ? 0 : 1)}%
                    </text>
                  </g>
                ))}
                {rows.map((r, i) =>
                  i % xTickEvery === 0 ? (
                    <text
                      key={`x-${i}`}
                      x={xToPx(i)}
                      y={M.top + innerH + 16}
                      textAnchor="middle"
                      fontSize={10}
                      fill="#64748B"
                    >
                      {r.day.slice(5)}
                    </text>
                  ) : null
                )}
                {locSegs.map((seg, i) => (
                  <polyline
                    key={`loc-${i}`}
                    points={seg}
                    fill="none"
                    stroke={COLORS.location}
                    strokeWidth={1.5}
                    strokeDasharray="5 4"
                  />
                ))}
                {cohortSegs.map((seg, i) => (
                  <polyline
                    key={`co-${i}`}
                    points={seg}
                    fill="none"
                    stroke={COLORS.cohort}
                    strokeWidth={2}
                  />
                ))}
                {/* Hover detector */}
                {rows.map((r, i) => {
                  const bandW =
                    rows.length > 1 ? innerW / (rows.length - 1) : innerW;
                  return (
                    <rect
                      key={`hover-${i}`}
                      x={xToPx(i) - bandW / 2}
                      y={M.top}
                      width={bandW}
                      height={innerH}
                      fill="transparent"
                      onMouseEnter={() => setHoverIdx(i)}
                      onMouseLeave={() => setHoverIdx(null)}
                      style={{ cursor: "crosshair" }}
                    />
                  );
                })}
                {hoverIdx !== null && (
                  <line
                    x1={xToPx(hoverIdx)}
                    x2={xToPx(hoverIdx)}
                    y1={M.top}
                    y2={M.top + innerH}
                    stroke="#0F172A"
                    strokeWidth={0.5}
                    strokeDasharray="2 3"
                    pointerEvents="none"
                  />
                )}
                <text
                  x={14}
                  y={M.top + innerH / 2}
                  textAnchor="middle"
                  fontSize={11}
                  fill="#0F172A"
                  transform={`rotate(-90 14 ${M.top + innerH / 2})`}
                >
                  Tip rate %
                </text>
              </svg>

              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 min-h-[60px]">
                {hovered ? (
                  <div className="flex flex-wrap gap-x-6 gap-y-1">
                    <span className="font-semibold text-slate-900">
                      {hovered.day}
                    </span>
                    <span>
                      <span className="text-slate-500">Cohort rate: </span>
                      <span style={{ color: COLORS.cohort, fontWeight: 600 }}>
                        {formatPercent(hovered.cohort_tip_rate_pct)}
                      </span>
                    </span>
                    <span>
                      <span className="text-slate-500">Location rate: </span>
                      <span style={{ color: COLORS.location, fontWeight: 600 }}>
                        {formatPercent(hovered.location_tip_rate_pct)}
                      </span>
                    </span>
                    <span>
                      <span className="text-slate-500">Cohort sales: </span>
                      {formatMoney(hovered.cohort_sales)}
                    </span>
                    <span>
                      <span className="text-slate-500">Cohort tips: </span>
                      {formatMoney(hovered.cohort_tips)}
                    </span>
                  </div>
                ) : (
                  <span className="text-slate-500">
                    Hover the chart to see daily numbers. Gaps in the cohort
                    line are days they weren&apos;t co-shifted exactly.
                  </span>
                )}
              </div>

              <div className="flex items-center gap-4 text-xs text-slate-600">
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-0.5 w-6"
                    style={{ background: COLORS.cohort }}
                  />
                  Cohort tip rate
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-0.5 w-6"
                    style={{
                      background: `repeating-linear-gradient(to right, ${COLORS.location}, ${COLORS.location} 4px, transparent 4px, transparent 8px)`,
                    }}
                  />
                  Location avg
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
