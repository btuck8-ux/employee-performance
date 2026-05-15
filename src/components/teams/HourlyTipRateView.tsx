"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchHourlyTipRateAction,
  type HourlyTipRateRow,
} from "@/app/dashboard/locations/[id]/teams/fetch-hourly-tip-rate-actions";
import {
  TimeWindowPicker,
  type QuarterOption,
  type TimeWindow,
} from "./TimeWindowPicker";
import { formatMoney, formatPercent } from "@/lib/format";

interface HourlyTipRateViewProps {
  employeeId: string;
  employeeName: string;
  locationId: string;
  initialRows: HourlyTipRateRow[];
  initialWindow: TimeWindow;
  quarters: QuarterOption[];
  earliestDate: string | null;
  latestDate?: string | null;
}

type ViewMode = "hourly" | "periods";

interface ChartPoint {
  /** Display label (e.g., "10am" or "Lunch") */
  label: string;
  /** Underlying numeric position on the x axis (0-indexed) */
  x: number;
  employee_hours_worked: number;
  employee_sales: number;
  employee_tips: number;
  employee_tip_rate_pct: number | null;
  location_sales: number;
  location_tips: number;
  location_tip_rate_pct: number | null;
  /** Span description for the tooltip (e.g., "10:00-10:59" or "10am-2pm") */
  span: string;
}

/** Service-period definitions. Tucker's spec: Lunch 10-2, Afternoon 2-4, Dinner 4-9. */
const PERIODS: Array<{
  label: string;
  span: string;
  hours: number[];
}> = [
  { label: "Lunch", span: "10am-2pm", hours: [10, 11, 12, 13] },
  { label: "Afternoon", span: "2pm-4pm", hours: [14, 15] },
  { label: "Dinner", span: "4pm-9pm", hours: [16, 17, 18, 19, 20] },
];

function hourLabel(h: number): string {
  if (h === 0) return "12am";
  if (h < 12) return `${h}am`;
  if (h === 12) return "12pm";
  return `${h - 12}pm`;
}

function buildHourlyPoints(rows: HourlyTipRateRow[]): ChartPoint[] {
  const byHour = new Map(rows.map((r) => [r.hour_of_day, r]));
  return Array.from({ length: 11 }, (_, i) => {
    const h = 10 + i;
    const r = byHour.get(h);
    return {
      label: hourLabel(h),
      x: i,
      employee_hours_worked: r?.employee_hours_worked ?? 0,
      employee_sales: r?.employee_sales ?? 0,
      employee_tips: r?.employee_tips ?? 0,
      employee_tip_rate_pct: r?.employee_tip_rate_pct ?? null,
      location_sales: r?.location_sales ?? 0,
      location_tips: r?.location_tips ?? 0,
      location_tip_rate_pct: r?.location_tip_rate_pct ?? null,
      span: `${hourLabel(h)} - ${hourLabel(h + 1)}`,
    };
  });
}

function buildPeriodPoints(rows: HourlyTipRateRow[]): ChartPoint[] {
  const byHour = new Map(rows.map((r) => [r.hour_of_day, r]));
  return PERIODS.map((p, i) => {
    let empSales = 0,
      empTips = 0,
      empHours = 0,
      locSales = 0,
      locTips = 0;
    for (const h of p.hours) {
      const r = byHour.get(h);
      if (!r) continue;
      empSales += r.employee_sales;
      empTips += r.employee_tips;
      empHours += r.employee_hours_worked;
      locSales += r.location_sales;
      locTips += r.location_tips;
    }
    return {
      label: p.label,
      x: i,
      employee_hours_worked: empHours,
      employee_sales: empSales,
      employee_tips: empTips,
      employee_tip_rate_pct: empSales > 0 ? (empTips / empSales) * 100 : null,
      location_sales: locSales,
      location_tips: locTips,
      location_tip_rate_pct: locSales > 0 ? (locTips / locSales) * 100 : null,
      span: p.span,
    };
  });
}

export function HourlyTipRateView({
  employeeId,
  employeeName,
  locationId,
  initialRows,
  initialWindow,
  quarters,
  earliestDate,
  latestDate,
}: HourlyTipRateViewProps) {
  const [timeWindow, setTimeWindow] = useState<TimeWindow>(initialWindow);
  const [rows, setRows] = useState<HourlyTipRateRow[]>(initialRows);
  const [view, setView] = useState<ViewMode>("hourly");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Avoid re-fetching the SSR-prefetched slice when the page first mounts —
  // but DO fetch on first mount when the caller passed empty initialRows
  // (e.g., the Teams-dashboard tab before an employee has been picked, then
  // picks one for the first time).
  const fetchKey = `${employeeId}|${timeWindow.startDate}|${timeWindow.endDate}`;
  const initialKey = `${employeeId}|${initialWindow.startDate}|${initialWindow.endDate}`;
  const lastFetchedKey = useRef<string | null>(
    initialRows.length > 0 ? initialKey : null
  );

  useEffect(() => {
    if (lastFetchedKey.current === fetchKey) return;
    lastFetchedKey.current = fetchKey;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchHourlyTipRateAction({
      employee_id: employeeId,
      location_id: locationId,
      start_date: timeWindow.startDate,
      end_date: timeWindow.endDate,
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
  }, [fetchKey, employeeId, locationId, timeWindow.startDate, timeWindow.endDate]);

  const points = useMemo(
    () => (view === "hourly" ? buildHourlyPoints(rows) : buildPeriodPoints(rows)),
    [rows, view]
  );

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-slate-900">
            {employeeName} · tip rate per {view === "hourly" ? "hour" : "service period"}
          </p>
          <p className="text-xs text-slate-500">
            Solid line = this employee. Dashed line = location average over the same hours.
            Window: <strong>{timeWindow.label}</strong>{" "}
            ({timeWindow.startDate} → {timeWindow.endDate})
          </p>
        </div>
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setView("hourly")}
            className={
              "px-3 py-1.5 " +
              (view === "hourly"
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-700 hover:bg-slate-50")
            }
          >
            Hours
          </button>
          <button
            type="button"
            onClick={() => setView("periods")}
            className={
              "px-3 py-1.5 " +
              (view === "periods"
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-700 hover:bg-slate-50")
            }
          >
            Service periods
          </button>
        </div>
      </div>

      <TimeWindowPicker
        quarters={quarters}
        earliestDate={earliestDate}
        latestDate={latestDate}
        value={timeWindow}
        onChange={setTimeWindow}
      />

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          Could not load hourly data: {error}
        </div>
      )}

      <LineChart points={points} loading={loading} />
    </div>
  );
}

// ----------------------------------------------------------------------------
// LineChart — pure-SVG two-series chart with hover tooltip
// ----------------------------------------------------------------------------

interface LineChartProps {
  points: ChartPoint[];
  loading: boolean;
}

const COLORS = {
  employee: "#0F766E", // teal-700, solid line
  location: "#64748B", // slate-500, dashed line
};

function LineChart({ points, loading }: LineChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const W = 880;
  const H = 360;
  const M = { top: 20, right: 24, bottom: 50, left: 48 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;

  // Y-axis range: include both series, give a 10% headroom; floor at 0 since
  // tip-rate can't be negative in practice (refunds net but the result stays
  // positive at the aggregate level for any meaningful window).
  const yMaxRaw = Math.max(
    1,
    ...points.flatMap((p) => [
      p.employee_tip_rate_pct ?? 0,
      p.location_tip_rate_pct ?? 0,
    ])
  );
  const yMax = Math.ceil(yMaxRaw * 1.1 * 4) / 4; // round up to nearest 0.25

  const xToPx = (x: number) =>
    M.left + (points.length === 1 ? innerW / 2 : (x / (points.length - 1)) * innerW);
  const yToPx = (y: number) => M.top + innerH - (y / yMax) * innerH;

  // Y ticks every 1% (or wider if range is large)
  const tickStep = yMax > 10 ? 2 : yMax > 4 ? 1 : 0.5;
  const yTicks: number[] = [];
  for (let v = 0; v <= yMax + 1e-9; v += tickStep) {
    yTicks.push(Math.round(v * 100) / 100);
  }

  // Build polyline segments — null breaks the line.
  function segments(getter: (p: ChartPoint) => number | null): string[] {
    const segs: string[] = [];
    let cur: string[] = [];
    for (const p of points) {
      const v = getter(p);
      if (v === null) {
        if (cur.length > 1) segs.push(cur.join(" "));
        cur = [];
      } else {
        cur.push(`${xToPx(p.x)},${yToPx(v)}`);
      }
    }
    if (cur.length > 1) segs.push(cur.join(" "));
    return segs;
  }
  const empSegs = segments((p) => p.employee_tip_rate_pct);
  const locSegs = segments((p) => p.location_tip_rate_pct);

  const noData =
    points.length === 0 ||
    points.every(
      (p) =>
        p.employee_tip_rate_pct === null && p.location_tip_rate_pct === null
    );

  const hovered = hoverIdx !== null ? points[hoverIdx] : null;

  return (
    <div className="space-y-3 relative">
      {loading && (
        <div className="absolute right-2 top-2 z-10 text-xs text-slate-500 bg-white/90 px-2 py-1 rounded border border-slate-200">
          Loading…
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label="Hourly tip rate chart"
      >
        {/* Plot area */}
        <rect
          x={M.left}
          y={M.top}
          width={innerW}
          height={innerH}
          fill="#FAFAFB"
          stroke="#E2E8F0"
        />

        {/* Y grid + labels */}
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

        {/* X labels */}
        {points.map((p, i) => (
          <g key={`x-${i}`}>
            <line
              x1={xToPx(p.x)}
              x2={xToPx(p.x)}
              y1={M.top}
              y2={M.top + innerH}
              stroke="#E2E8F0"
              strokeWidth={0.5}
            />
            <text
              x={xToPx(p.x)}
              y={M.top + innerH + 16}
              textAnchor="middle"
              fontSize={10}
              fill="#64748B"
            >
              {p.label}
            </text>
          </g>
        ))}

        {/* Location line (dashed) */}
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

        {/* Employee line (solid) */}
        {empSegs.map((seg, i) => (
          <polyline
            key={`emp-${i}`}
            points={seg}
            fill="none"
            stroke={COLORS.employee}
            strokeWidth={2}
          />
        ))}

        {/* Markers */}
        {points.map((p, i) =>
          p.location_tip_rate_pct === null ? null : (
            <circle
              key={`lm-${i}`}
              cx={xToPx(p.x)}
              cy={yToPx(p.location_tip_rate_pct)}
              r={3}
              fill="#FFFFFF"
              stroke={COLORS.location}
              strokeWidth={1.5}
            />
          )
        )}
        {points.map((p, i) =>
          p.employee_tip_rate_pct === null ? null : (
            <circle
              key={`em-${i}`}
              cx={xToPx(p.x)}
              cy={yToPx(p.employee_tip_rate_pct)}
              r={hoverIdx === i ? 5 : 3.5}
              fill={COLORS.employee}
              stroke="#FFFFFF"
              strokeWidth={1.5}
            />
          )
        )}

        {/* Hover detector (invisible wide rects covering each x-band) */}
        {points.map((p, i) => {
          const bandW =
            points.length > 1 ? innerW / (points.length - 1) : innerW;
          return (
            <rect
              key={`hover-${i}`}
              x={xToPx(p.x) - bandW / 2}
              y={M.top}
              width={bandW}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              style={{ cursor: "pointer" }}
            />
          );
        })}

        {/* Hover guide line */}
        {hoverIdx !== null && (
          <line
            x1={xToPx(points[hoverIdx].x)}
            x2={xToPx(points[hoverIdx].x)}
            y1={M.top}
            y2={M.top + innerH}
            stroke="#0F172A"
            strokeWidth={0.5}
            strokeDasharray="2 3"
            pointerEvents="none"
          />
        )}

        {/* No-data overlay */}
        {noData && (
          <text
            x={M.left + innerW / 2}
            y={M.top + innerH / 2}
            textAnchor="middle"
            fontSize={13}
            fill="#94A3B8"
          >
            No sales / shift overlap in this window.
          </text>
        )}

        {/* Y axis title */}
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

      {/* Detail box */}
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 min-h-[68px]">
        {hovered ? (
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span className="font-semibold text-slate-900">
              {hovered.label} <span className="text-slate-500">· {hovered.span}</span>
            </span>
            <span>
              <span className="text-slate-500">Employee rate: </span>
              <span style={{ color: COLORS.employee, fontWeight: 600 }}>
                {formatPercent(hovered.employee_tip_rate_pct)}
              </span>
            </span>
            <span>
              <span className="text-slate-500">Location rate: </span>
              <span style={{ color: COLORS.location, fontWeight: 600 }}>
                {formatPercent(hovered.location_tip_rate_pct)}
              </span>
            </span>
            <span>
              <span className="text-slate-500">Hours worked: </span>
              {hovered.employee_hours_worked.toFixed(1)}
            </span>
            <span>
              <span className="text-slate-500">Sales: </span>
              {formatMoney(hovered.employee_sales)}
            </span>
            <span>
              <span className="text-slate-500">Tips: </span>
              {formatMoney(hovered.employee_tips)}
            </span>
          </div>
        ) : (
          <span className="text-slate-500">
            Hover the chart to see hour-level numbers (employee tip rate vs
            location average, hours worked, and sales rung).
          </span>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-slate-600">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-6"
            style={{ background: COLORS.employee }}
          />
          {`Employee tip rate`}
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
    </div>
  );
}
