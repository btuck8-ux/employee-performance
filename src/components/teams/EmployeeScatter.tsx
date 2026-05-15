"use client";
import { useMemo, useState } from "react";
import {
  formatDeltaPP,
  formatMoney,
  formatPercent,
} from "@/lib/format";

export interface ScatterRow {
  employeeId: string;
  employeeName: string;
  hoursWorked: number;
  tipRatePct: number;
  locationTipRatePct: number | null;
  tipRateDeltaPp: number | null;
  tipPerHour: number | null;
  sales: number | null;
  tips: number | null;
}

interface EmployeeScatterProps {
  rows: ScatterRow[];
}

/** Neutral band around the location tip-rate average (percentage points). */
const NEUTRAL_PP = 0.25;

/** Color encoding for the tip-rate delta — matches the existing badge logic. */
function colorFor(deltaPp: number | null): {
  fill: string;
  stroke: string;
} {
  if (deltaPp === null) return { fill: "#CBD5E1", stroke: "#64748B" };
  if (deltaPp > NEUTRAL_PP) return { fill: "#86EFAC", stroke: "#15803D" };
  if (deltaPp < -NEUTRAL_PP) return { fill: "#FCA5A5", stroke: "#B91C1C" };
  return { fill: "#FDE68A", stroke: "#B45309" };
}

/** Computes a "nice" round number for axis ticks (1, 2, 5, 10, …). */
function niceTick(range: number, targetTicks = 5): number {
  if (range <= 0) return 1;
  const rawStep = range / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  let nice = 1;
  if (normalized < 1.5) nice = 1;
  else if (normalized < 3) nice = 2;
  else if (normalized < 7) nice = 5;
  else nice = 10;
  return nice * magnitude;
}

export function EmployeeScatter({ rows }: EmployeeScatterProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const layout = useMemo(() => {
    // Viewbox + margins. Y-axis is symmetric around 0 so quadrants line up
    // exactly at the location-average reference line.
    const W = 880;
    const H = 480;
    const M = { top: 36, right: 32, bottom: 56, left: 64 };
    const innerW = W - M.left - M.right;
    const innerH = H - M.top - M.bottom;

    if (rows.length === 0) {
      return { W, H, M, innerW, innerH, xMax: 0, yMax: 1, xTick: 1, yTick: 0.5 };
    }

    const xMaxRaw = Math.max(...rows.map((r) => r.hoursWorked));
    const yAbsMaxRaw = Math.max(
      0.5,
      ...rows
        .map((r) => (r.tipRateDeltaPp === null ? 0 : Math.abs(r.tipRateDeltaPp)))
    );

    const xTick = niceTick(xMaxRaw);
    const yTick = niceTick(yAbsMaxRaw);
    const xMax = Math.ceil(xMaxRaw / xTick) * xTick;
    const yMax = Math.ceil(yAbsMaxRaw / yTick) * yTick;

    return { W, H, M, innerW, innerH, xMax, yMax, xTick, yTick };
  }, [rows]);

  const { W, H, M, innerW, innerH, xMax, yMax, xTick, yTick } = layout;

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-8 text-sm text-slate-500">
        No employees have tip data for this quarter yet. Upload POS sales for
        the location to populate the scatter.
      </div>
    );
  }

  const xToPx = (x: number) => M.left + (x / xMax) * innerW;
  const yToPx = (y: number) => M.top + innerH / 2 - (y / yMax) * (innerH / 2);

  // Median hours, drawn as a vertical reference line — separates scale from
  // niche-impact in the quadrant labels.
  const medianHours = (() => {
    const xs = rows.map((r) => r.hoursWorked).sort((a, b) => a - b);
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
  })();

  const xTicks: number[] = [];
  for (let v = 0; v <= xMax + 1e-9; v += xTick) xTicks.push(Math.round(v * 100) / 100);
  const yTicks: number[] = [];
  for (let v = -yMax; v <= yMax + 1e-9; v += yTick)
    yTicks.push(Math.round(v * 100) / 100);

  const hovered = hoveredId ? rows.find((r) => r.employeeId === hoveredId) : null;

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm text-slate-700">
          Each dot is one employee&apos;s quarter. X = hours worked, Y = tip
          rate vs the location average (percentage points).
        </p>
        <Legend />
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label="Employee scatter chart: hours worked vs tip-rate delta"
      >
        {/* Plot background */}
        <rect
          x={M.left}
          y={M.top}
          width={innerW}
          height={innerH}
          fill="#FAFAFB"
          stroke="#E2E8F0"
        />

        {/* Y-axis grid + ticks */}
        {yTicks.map((t) => (
          <g key={`y-${t}`}>
            <line
              x1={M.left}
              x2={M.left + innerW}
              y1={yToPx(t)}
              y2={yToPx(t)}
              stroke={t === 0 ? "#0F172A" : "#E2E8F0"}
              strokeWidth={t === 0 ? 1.5 : 0.5}
            />
            <text
              x={M.left - 8}
              y={yToPx(t)}
              textAnchor="end"
              dominantBaseline="central"
              fontSize={10}
              fill="#64748B"
            >
              {t > 0 ? "+" : ""}
              {t.toFixed(1)}pp
            </text>
          </g>
        ))}

        {/* X-axis grid + ticks */}
        {xTicks.map((t) => (
          <g key={`x-${t}`}>
            <line
              x1={xToPx(t)}
              x2={xToPx(t)}
              y1={M.top}
              y2={M.top + innerH}
              stroke="#E2E8F0"
              strokeWidth={0.5}
            />
            <text
              x={xToPx(t)}
              y={M.top + innerH + 16}
              textAnchor="middle"
              fontSize={10}
              fill="#64748B"
            >
              {Math.round(t)}
            </text>
          </g>
        ))}

        {/* Median-hours reference line (vertical, dashed) */}
        {medianHours > 0 && (
          <line
            x1={xToPx(medianHours)}
            x2={xToPx(medianHours)}
            y1={M.top}
            y2={M.top + innerH}
            stroke="#94A3B8"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        )}

        {/* Quadrant labels */}
        <text
          x={M.left + innerW - 8}
          y={M.top + 14}
          textAnchor="end"
          fontSize={10}
          fill="#15803D"
          fontWeight={600}
        >
          High-impact lifters
        </text>
        <text
          x={M.left + 8}
          y={M.top + 14}
          textAnchor="start"
          fontSize={10}
          fill="#15803D"
          fontWeight={600}
        >
          Rising stars
        </text>
        <text
          x={M.left + innerW - 8}
          y={M.top + innerH - 8}
          textAnchor="end"
          fontSize={10}
          fill="#B91C1C"
          fontWeight={600}
        >
          Scale drag
        </text>
        <text
          x={M.left + 8}
          y={M.top + innerH - 8}
          textAnchor="start"
          fontSize={10}
          fill="#B91C1C"
          fontWeight={600}
        >
          Low-impact drag
        </text>

        {/* Axis titles */}
        <text
          x={M.left + innerW / 2}
          y={H - 12}
          textAnchor="middle"
          fontSize={11}
          fill="#0F172A"
        >
          Hours worked in quarter
        </text>
        <text
          x={18}
          y={M.top + innerH / 2}
          textAnchor="middle"
          fontSize={11}
          fill="#0F172A"
          transform={`rotate(-90 18 ${M.top + innerH / 2})`}
        >
          Tip rate vs location avg (pp)
        </text>

        {/* Data points — hovered drawn last so it's on top */}
        {rows
          .slice()
          .sort((a, b) =>
            a.employeeId === hoveredId ? 1 : b.employeeId === hoveredId ? -1 : 0
          )
          .map((r) => {
            const c = colorFor(r.tipRateDeltaPp);
            const isHovered = r.employeeId === hoveredId;
            return (
              <circle
                key={r.employeeId}
                cx={xToPx(r.hoursWorked)}
                cy={yToPx(r.tipRateDeltaPp ?? 0)}
                r={isHovered ? 8 : 6}
                fill={c.fill}
                stroke={c.stroke}
                strokeWidth={isHovered ? 2 : 1}
                opacity={hoveredId && !isHovered ? 0.4 : 0.9}
                onMouseEnter={() => setHoveredId(r.employeeId)}
                onMouseLeave={() => setHoveredId(null)}
                style={{ cursor: "pointer" }}
              />
            );
          })}
      </svg>

      {/* Detail box (shows on hover; otherwise an instructional note) */}
      <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 min-h-[52px]">
        {hovered ? (
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span className="font-semibold text-slate-900">
              {hovered.employeeName}
            </span>
            <span>
              <span className="text-slate-500">Hours: </span>
              {hovered.hoursWorked.toFixed(1)}
            </span>
            <span>
              <span className="text-slate-500">Tip rate: </span>
              {formatPercent(hovered.tipRatePct)}
            </span>
            <span>
              <span className="text-slate-500">Loc avg: </span>
              {formatPercent(hovered.locationTipRatePct)}
            </span>
            <span>
              <span className="text-slate-500">Δ: </span>
              {formatDeltaPP(hovered.tipRateDeltaPp)}
            </span>
            <span>
              <span className="text-slate-500">Tip/hr: </span>
              {formatMoney(hovered.tipPerHour)}
            </span>
            <span>
              <span className="text-slate-500">Sales: </span>
              {formatMoney(hovered.sales)}
            </span>
          </div>
        ) : (
          <span className="text-slate-500">
            Hover a dot to see the employee&apos;s numbers.
          </span>
        )}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-xs text-slate-600">
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-3 w-3 rounded-full border"
          style={{ background: "#86EFAC", borderColor: "#15803D" }}
        />
        Lift &gt; +0.25pp
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-3 w-3 rounded-full border"
          style={{ background: "#FDE68A", borderColor: "#B45309" }}
        />
        Within ±0.25pp
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-3 w-3 rounded-full border"
          style={{ background: "#FCA5A5", borderColor: "#B91C1C" }}
        />
        Drag &lt; −0.25pp
      </span>
    </div>
  );
}
