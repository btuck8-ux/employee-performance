"use client";
import { useMemo, useState } from "react";
import {
  formatDeltaPP,
  formatMoney,
  formatPercent,
} from "@/lib/format";
import type { ScatterRow } from "./EmployeeScatter";

interface EmployeeDeltaBarProps {
  rows: ScatterRow[];
}

const NEUTRAL_PP = 0.25;

const COLORS = {
  lift: "#15803D",   // emerald-700
  drag: "#B91C1C",   // red-700
  flat: "#B45309",   // amber-700
  rule: "#0F172A",
};

/**
 * Horizontal bar chart of employees ranked by tip_rate_delta_pp.
 *
 * Bars to the right of the zero axis = lift, to the left = drag. Bar length
 * encodes magnitude; color encodes side / sign. Hover gives the employee's
 * absolute tip rate, hours, and sales for context. Same ScatterRow source
 * as the scatter tab — no extra fetch.
 */
export function EmployeeDeltaBar({ rows }: EmployeeDeltaBarProps) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  const sorted = useMemo(() => {
    return rows
      .filter((r) => r.tipRateDeltaPp !== null)
      .slice()
      .sort((a, b) => (b.tipRateDeltaPp ?? 0) - (a.tipRateDeltaPp ?? 0));
  }, [rows]);

  if (sorted.length === 0) {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-8 text-sm text-slate-500">
        No employees have a computed tip-rate delta for this quarter. Upload
        POS sales to populate.
      </div>
    );
  }

  const maxAbs = Math.max(
    ...sorted.map((r) => Math.abs(r.tipRateDeltaPp ?? 0)),
    NEUTRAL_PP
  );
  // Round up to nearest 0.5 so the axis is a clean number.
  const axisMax = Math.ceil(maxAbs * 2) / 2;

  const ROW_H = 26;
  const LABEL_W = 200;
  const W = 880;
  const innerW = W - LABEL_W - 24;
  const H = sorted.length * ROW_H + 40 + 32; // header + footer
  const CENTER_X = LABEL_W + innerW / 2;
  const halfW = innerW / 2;

  const xToPx = (delta: number) =>
    CENTER_X + (delta / axisMax) * halfW;

  // Axis ticks: integer steps if axisMax >= 2, else 0.5 steps
  const tickStep = axisMax >= 4 ? 1 : axisMax >= 2 ? 0.5 : 0.25;
  const ticks: number[] = [];
  for (let v = -axisMax; v <= axisMax + 1e-9; v += tickStep) {
    ticks.push(Math.round(v * 100) / 100);
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm text-slate-700">
          Employees ranked by tip-rate delta vs the location average. Bars
          right of zero lift the rate; bars left drag it. Length = magnitude
          (percentage points).
        </p>
        <div className="flex items-center gap-3 text-xs text-slate-600">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ background: COLORS.lift }}
            />
            Lift &gt; +{NEUTRAL_PP}pp
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ background: COLORS.flat }}
            />
            Within ±{NEUTRAL_PP}pp
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ background: COLORS.drag }}
            />
            Drag &lt; −{NEUTRAL_PP}pp
          </span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label="Employee tip-rate delta ranking"
      >
        {/* Plot background */}
        <rect
          x={LABEL_W}
          y={28}
          width={innerW}
          height={H - 60}
          fill="#FAFAFB"
          stroke="#E2E8F0"
        />

        {/* Axis ticks (vertical grid + labels) */}
        {ticks.map((t) => (
          <g key={`t-${t}`}>
            <line
              x1={xToPx(t)}
              x2={xToPx(t)}
              y1={28}
              y2={H - 32}
              stroke={t === 0 ? COLORS.rule : "#E2E8F0"}
              strokeWidth={t === 0 ? 1.25 : 0.5}
            />
            <text
              x={xToPx(t)}
              y={20}
              textAnchor="middle"
              fontSize={10}
              fill="#64748B"
            >
              {t > 0 ? "+" : ""}
              {t.toFixed(tickStep < 1 ? 1 : 0)}pp
            </text>
            <text
              x={xToPx(t)}
              y={H - 18}
              textAnchor="middle"
              fontSize={10}
              fill="#64748B"
            >
              {t > 0 ? "+" : ""}
              {t.toFixed(tickStep < 1 ? 1 : 0)}pp
            </text>
          </g>
        ))}

        {/* Bars */}
        {sorted.map((r, i) => {
          const delta = r.tipRateDeltaPp ?? 0;
          const y = 28 + i * ROW_H + 4;
          const barH = ROW_H - 8;
          const color =
            delta > NEUTRAL_PP
              ? COLORS.lift
              : delta < -NEUTRAL_PP
                ? COLORS.drag
                : COLORS.flat;
          const startX = delta >= 0 ? CENTER_X : xToPx(delta);
          const w = Math.abs(xToPx(delta) - CENTER_X);
          const isHovered = hoverId === r.employeeId;
          return (
            <g
              key={r.employeeId}
              onMouseEnter={() => setHoverId(r.employeeId)}
              onMouseLeave={() => setHoverId(null)}
              style={{ cursor: "pointer" }}
            >
              {/* Hit area = full row */}
              <rect
                x={0}
                y={28 + i * ROW_H}
                width={W}
                height={ROW_H}
                fill={isHovered ? "#0F172A0A" : "transparent"}
              />
              {/* Name */}
              <text
                x={LABEL_W - 8}
                y={y + barH / 2 + 1}
                textAnchor="end"
                dominantBaseline="central"
                fontSize={11}
                fill="#0F172A"
                fontWeight={isHovered ? 700 : 500}
              >
                {r.employeeName}
              </text>
              {/* Bar */}
              <rect
                x={startX}
                y={y}
                width={Math.max(w, 1)}
                height={barH}
                fill={color}
                opacity={hoverId && !isHovered ? 0.4 : 0.9}
                rx={2}
              />
              {/* Delta label outside the bar tip */}
              <text
                x={delta >= 0 ? startX + w + 4 : startX - 4}
                y={y + barH / 2 + 1}
                textAnchor={delta >= 0 ? "start" : "end"}
                dominantBaseline="central"
                fontSize={10}
                fill={color}
                fontWeight={isHovered ? 700 : 600}
              >
                {formatDeltaPP(delta)}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 min-h-[60px]">
        {hoverId ? (() => {
          const r = sorted.find((x) => x.employeeId === hoverId);
          if (!r) return null;
          return (
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <span className="font-semibold text-slate-900">{r.employeeName}</span>
              <span>
                <span className="text-slate-500">Tip rate: </span>
                {formatPercent(r.tipRatePct)}
              </span>
              <span>
                <span className="text-slate-500">Location avg: </span>
                {formatPercent(r.locationTipRatePct)}
              </span>
              <span>
                <span className="text-slate-500">Δ: </span>
                {formatDeltaPP(r.tipRateDeltaPp)}
              </span>
              <span>
                <span className="text-slate-500">Hours: </span>
                {r.hoursWorked.toFixed(1)}
              </span>
              <span>
                <span className="text-slate-500">Sales: </span>
                {formatMoney(r.sales)}
              </span>
              <span>
                <span className="text-slate-500">Tip / hr: </span>
                {formatMoney(r.tipPerHour)}
              </span>
            </div>
          );
        })() : (
          <span className="text-slate-500">
            Hover a row for the employee&apos;s absolute tip rate, hours, and
            sales context.
          </span>
        )}
      </div>
    </div>
  );
}
