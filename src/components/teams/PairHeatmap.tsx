"use client";
import { useMemo, useState } from "react";
import {
  formatDeltaPP,
  formatMoney,
  formatPercent,
} from "@/lib/format";
import type { TeamRow } from "./TeamLeaderboard";

interface PairHeatmapProps {
  teams: TeamRow[];
  employees: Array<{ id: string; employee_name: string }>;
}

/** Diverging color: red at -maxAbs, yellow at 0, green at +maxAbs.
 *  Returns an HSL string. */
function colorForDelta(delta: number, maxAbs: number): string {
  if (maxAbs <= 0) return "hsl(50, 70%, 80%)";
  const t = Math.max(-1, Math.min(1, delta / maxAbs));
  // Map t in [-1, 1] to hue: red(0°) → yellow(50°) → green(140°)
  // Use two linear pieces so yellow is locked at t = 0
  let hue: number;
  if (t < 0) hue = 0 + (1 + t) * 50; // -1 → 0°, 0 → 50°
  else hue = 50 + t * 90;            //  0 → 50°, 1 → 140°
  // Saturation higher at the extremes for legibility
  const sat = 55 + Math.abs(t) * 25;
  // Lightness inverse of magnitude — extremes pop, near-zero stays pale
  const light = 80 - Math.abs(t) * 25;
  return `hsl(${hue.toFixed(0)}, ${sat.toFixed(0)}%, ${light.toFixed(0)}%)`;
}

export function PairHeatmap({ teams, employees }: PairHeatmapProps) {
  const [hovered, setHovered] = useState<{
    aId: string;
    bId: string;
  } | null>(null);

  // Filter team rows to pairs only.
  const pairs = useMemo(
    () => teams.filter((t) => t.memberCount === 2),
    [teams]
  );

  // Index by (aId, bId) sorted so lookup is symmetric.
  const pairIndex = useMemo(() => {
    const m = new Map<string, TeamRow>();
    for (const p of pairs) {
      const [a, b] = p.memberIds; // already sorted from the SQL function
      m.set(`${a}|${b}`, p);
    }
    return m;
  }, [pairs]);

  // Restrict the axis to employees that actually appear in at least one pair
  // this quarter — Fort Collins has 38 active employees but typically only
  // 20-ish are paired in a given quarter; showing all 38 would make the grid
  // mostly empty.
  const axisEmployees = useMemo(() => {
    const used = new Set<string>();
    for (const p of pairs) {
      used.add(p.memberIds[0]);
      used.add(p.memberIds[1]);
    }
    return employees.filter((e) => used.has(e.id));
  }, [pairs, employees]);

  // Maximum |delta| for the color scale.
  const maxAbsDelta = useMemo(() => {
    let mx = 0;
    for (const p of pairs) {
      if (p.deltaVsLocPp !== null) {
        mx = Math.max(mx, Math.abs(p.deltaVsLocPp));
      }
    }
    return mx;
  }, [pairs]);

  // Maximum hours (for opacity scaling).
  const maxHours = useMemo(
    () => pairs.reduce((mx, p) => Math.max(mx, p.hoursTogether), 0),
    [pairs]
  );

  if (pairs.length === 0) {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-8 text-sm text-slate-500">
        No paired shifts for this quarter. Solo-only locations or quarters
        without POS data won&apos;t populate a heatmap.
      </div>
    );
  }

  const N = axisEmployees.length;
  // Cell size scales down for big matrices but never goes below 16px or above
  // 28px. Label gutter scales with the longest name.
  const CELL = N <= 10 ? 28 : N <= 20 ? 22 : N <= 30 ? 18 : 16;
  const longestName = axisEmployees.reduce(
    (mx, e) => Math.max(mx, e.employee_name.length),
    0
  );
  const LABEL_PX = Math.max(120, Math.min(180, longestName * 7));
  const W = LABEL_PX + N * CELL + 8;
  const H = LABEL_PX + N * CELL + 8;

  const hoveredPair = hovered
    ? pairIndex.get(`${hovered.aId}|${hovered.bId}`) ??
      pairIndex.get(`${hovered.bId}|${hovered.aId}`)
    : null;
  const hoveredA = hovered
    ? axisEmployees.find((e) => e.id === hovered.aId)
    : null;
  const hoveredB = hovered
    ? axisEmployees.find((e) => e.id === hovered.bId)
    : null;

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm text-slate-700">
          Each cell is one pair of employees. Color shows their tip-rate delta
          vs the location average; saturation reflects how many hours they
          actually worked together.
        </p>
        <ColorLegend maxAbs={maxAbsDelta} />
      </div>

      <div className="overflow-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          role="img"
          aria-label="Pair heatmap"
        >
          {/* Column labels (rotated -55°) */}
          {axisEmployees.map((e, j) => (
            <text
              key={`col-${e.id}`}
              x={LABEL_PX + j * CELL + CELL / 2}
              y={LABEL_PX - 6}
              fontSize={Math.max(9, Math.min(11, CELL - 6))}
              fill="#334155"
              textAnchor="start"
              transform={`rotate(-55 ${LABEL_PX + j * CELL + CELL / 2} ${LABEL_PX - 6})`}
              style={{
                fontWeight:
                  hovered && (hovered.aId === e.id || hovered.bId === e.id)
                    ? 600
                    : 400,
              }}
            >
              {e.employee_name}
            </text>
          ))}

          {/* Row labels */}
          {axisEmployees.map((e, i) => (
            <text
              key={`row-${e.id}`}
              x={LABEL_PX - 6}
              y={LABEL_PX + i * CELL + CELL / 2}
              fontSize={Math.max(9, Math.min(11, CELL - 6))}
              fill="#334155"
              textAnchor="end"
              dominantBaseline="central"
              style={{
                fontWeight:
                  hovered && (hovered.aId === e.id || hovered.bId === e.id)
                    ? 600
                    : 400,
              }}
            >
              {e.employee_name}
            </text>
          ))}

          {/* Cells */}
          {axisEmployees.map((rowEmp, i) =>
            axisEmployees.map((colEmp, j) => {
              const x = LABEL_PX + j * CELL;
              const y = LABEL_PX + i * CELL;

              // Diagonal: render but render flat-gray
              if (rowEmp.id === colEmp.id) {
                return (
                  <rect
                    key={`d-${i}-${j}`}
                    x={x}
                    y={y}
                    width={CELL}
                    height={CELL}
                    fill="#E2E8F0"
                    stroke="#FFFFFF"
                    strokeWidth={1}
                  />
                );
              }

              // Symmetric lookup (sorted member_ids)
              const ids = [rowEmp.id, colEmp.id].sort();
              const pair = pairIndex.get(`${ids[0]}|${ids[1]}`);

              if (!pair) {
                return (
                  <rect
                    key={`e-${i}-${j}`}
                    x={x}
                    y={y}
                    width={CELL}
                    height={CELL}
                    fill="#F8FAFC"
                    stroke="#FFFFFF"
                    strokeWidth={1}
                  />
                );
              }

              const fill =
                pair.deltaVsLocPp === null
                  ? "#E2E8F0"
                  : colorForDelta(pair.deltaVsLocPp, maxAbsDelta);
              // Opacity from hours_together; clamp floor so the cell stays visible
              const opacity =
                maxHours > 0
                  ? Math.max(0.25, pair.hoursTogether / maxHours)
                  : 0.5;
              const isHoveredCell =
                hovered &&
                ((hovered.aId === rowEmp.id && hovered.bId === colEmp.id) ||
                  (hovered.bId === rowEmp.id && hovered.aId === colEmp.id));
              return (
                <rect
                  key={`c-${i}-${j}`}
                  x={x}
                  y={y}
                  width={CELL}
                  height={CELL}
                  fill={fill}
                  opacity={opacity}
                  stroke={isHoveredCell ? "#0F172A" : "#FFFFFF"}
                  strokeWidth={isHoveredCell ? 1.5 : 1}
                  onMouseEnter={() =>
                    setHovered({ aId: rowEmp.id, bId: colEmp.id })
                  }
                  onMouseLeave={() => setHovered(null)}
                  style={{ cursor: "pointer" }}
                />
              );
            })
          )}
        </svg>
      </div>

      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 min-h-[52px]">
        {hovered && hoveredPair && hoveredA && hoveredB ? (
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span className="font-semibold text-slate-900">
              {hoveredA.employee_name} &times; {hoveredB.employee_name}
            </span>
            <span>
              <span className="text-slate-500">Hours together: </span>
              {hoveredPair.hoursTogether.toFixed(1)}
            </span>
            <span>
              <span className="text-slate-500">Sales: </span>
              {formatMoney(hoveredPair.salesDuring)}
            </span>
            <span>
              <span className="text-slate-500">Tip rate: </span>
              {formatPercent(hoveredPair.tipRatePct)}
            </span>
            <span>
              <span className="text-slate-500">Δ vs loc: </span>
              {formatDeltaPP(hoveredPair.deltaVsLocPp)}
            </span>
          </div>
        ) : hovered && hoveredA && hoveredB && hoveredA.id !== hoveredB.id ? (
          <span className="text-slate-500">
            {hoveredA.employee_name} and {hoveredB.employee_name} never overlapped
            on a shift this quarter.
          </span>
        ) : (
          <span className="text-slate-500">
            Hover a cell to see the pair&apos;s numbers. Darker cells = more
            hours worked together.
          </span>
        )}
      </div>
    </div>
  );
}

function ColorLegend({ maxAbs }: { maxAbs: number }) {
  const stops = [-1, -0.5, 0, 0.5, 1];
  return (
    <div className="flex items-center gap-2 text-xs text-slate-600">
      <span>−{maxAbs.toFixed(2)}pp</span>
      <div className="flex">
        {stops.map((s) => (
          <span
            key={s}
            className="inline-block w-4 h-3"
            style={{ background: colorForDelta(s * maxAbs, maxAbs) }}
          />
        ))}
      </div>
      <span>+{maxAbs.toFixed(2)}pp</span>
    </div>
  );
}
