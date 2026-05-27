"use client";
import { useEffect, useMemo, useState } from "react";
import {
  fetchCsTrendTimeSeries,
  fetchCsTrendMultiLocation,
} from "@/app/dashboard/locations/[id]/teams/fetch-cs-trend-actions";
import {
  formatLocationCsScore,
  type LocationCsScore,
  type LocationCsBand,
} from "@/lib/location-cs-score";
import {
  CS_SCORE_GREEN_MIN,
  CS_SCORE_YELLOW_MIN,
} from "@/lib/customer-service-score";

interface LocationCsTrendViewProps {
  locationId: string;
  locationName: string;
  quarters: Array<{ id: string; label: string; period_start: string; period_end: string }>;
  /** The quarter currently selected at the dashboard level; used as the
   *  default for Multi-Location mode. May be null if no quarters exist. */
  initialQuarterId: string | null;
}

type ViewMode = "time_series" | "multi_location";

const BAND_FILL: Record<LocationCsBand, string> = {
  green: "#15803D",   // emerald-700
  yellow: "#B45309",  // amber-700
  red: "#B91C1C",     // red-700
  no_data: "#94A3B8", // slate-400
};

const BAND_BG: Record<Exclude<LocationCsBand, "no_data">, string> = {
  green: "#DCFCE7",   // emerald-100
  yellow: "#FEF3C7",  // amber-100
  red: "#FEE2E2",     // red-100
};

const LINE_COLOR = "#0F766E"; // teal-700

const BAND_LABEL: Record<LocationCsBand, string> = {
  green: "Exceeds",
  yellow: "Meets",
  red: "Below",
  no_data: "No data",
};

function bandPillClasses(band: LocationCsBand): string {
  switch (band) {
    case "green":
      return "bg-emerald-100 text-emerald-800 border-emerald-300";
    case "yellow":
      return "bg-amber-100 text-amber-800 border-amber-300";
    case "red":
      return "bg-red-100 text-red-800 border-red-300";
    case "no_data":
    default:
      return "bg-slate-100 text-slate-600 border-slate-300";
  }
}

export function LocationCsTrendView({
  locationId,
  locationName,
  quarters,
  initialQuarterId,
}: LocationCsTrendViewProps) {
  const [mode, setMode] = useState<ViewMode>("time_series");

  // ---- Time Series state ----
  const [tsRows, setTsRows] = useState<LocationCsScore[]>([]);
  const [tsLoading, setTsLoading] = useState(true);
  const [tsError, setTsError] = useState<string | null>(null);
  const [tsHoverIdx, setTsHoverIdx] = useState<number | null>(null);

  // ---- Multi-Location state ----
  const sortedQuarters = useMemo(
    () =>
      quarters
        .slice()
        .sort((a, b) => b.period_start.localeCompare(a.period_start)),
    [quarters]
  );
  const [mlQuarterId, setMlQuarterId] = useState<string>(
    initialQuarterId ?? sortedQuarters[0]?.id ?? ""
  );
  const [mlRows, setMlRows] = useState<LocationCsScore[]>([]);
  const [mlLoading, setMlLoading] = useState(false);
  const [mlError, setMlError] = useState<string | null>(null);
  const [mlHoverId, setMlHoverId] = useState<string | null>(null);

  // Lazy-load time series on first mount (cheap server-side; one RPC).
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTsLoading(true);
    setTsError(null);
    fetchCsTrendTimeSeries({ location_id: locationId })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setTsRows(res.rows);
        else setTsError(res.error);
        setTsLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setTsError(e instanceof Error ? e.message : String(e));
        setTsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  // Fetch multi-location whenever the selected quarter changes (and the user
  // is on / switching into multi-location mode).
  useEffect(() => {
    if (mode !== "multi_location") return;
    if (!mlQuarterId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMlLoading(true);
    setMlError(null);
    fetchCsTrendMultiLocation({ report_period_id: mlQuarterId })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setMlRows(res.rows);
        else setMlError(res.error);
        setMlLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setMlError(e instanceof Error ? e.message : String(e));
        setMlLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, mlQuarterId]);

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-4">
      {/* Mode toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-sm">
          <button
            type="button"
            onClick={() => setMode("time_series")}
            className={`px-3 py-1.5 ${
              mode === "time_series"
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-700 hover:bg-slate-50"
            }`}
            aria-pressed={mode === "time_series"}
          >
            Time series
          </button>
          <button
            type="button"
            onClick={() => setMode("multi_location")}
            className={`px-3 py-1.5 border-l border-slate-300 ${
              mode === "multi_location"
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-700 hover:bg-slate-50"
            }`}
            aria-pressed={mode === "multi_location"}
          >
            Multi-location
          </button>
        </div>
        <p className="text-xs text-slate-500 max-w-[500px]">
          Hours-weighted average of eligible employees&apos; Customer Service
          Scores (active + ≥40 all-time worked hours at this location).
          ≥85 exceeds, 70–85 meets, &lt;70 below.
        </p>
      </div>

      {mode === "time_series" ? (
        <TimeSeriesChart
          rows={tsRows}
          loading={tsLoading}
          error={tsError}
          locationName={locationName}
          hoverIdx={tsHoverIdx}
          onHoverIdx={setTsHoverIdx}
        />
      ) : (
        <MultiLocationChart
          rows={mlRows}
          loading={mlLoading}
          error={mlError}
          quarters={sortedQuarters}
          selectedQuarterId={mlQuarterId}
          onSelectQuarter={setMlQuarterId}
          currentLocationId={locationId}
          hoverId={mlHoverId}
          onHoverId={setMlHoverId}
        />
      )}
    </div>
  );
}

// ============================================================================
// Time-series sub-chart (line w/ threshold bands)
// ============================================================================

interface TimeSeriesChartProps {
  rows: LocationCsScore[];
  loading: boolean;
  error: string | null;
  locationName: string;
  hoverIdx: number | null;
  onHoverIdx: (idx: number | null) => void;
}

function TimeSeriesChart({
  rows,
  loading,
  error,
  locationName,
  hoverIdx,
  onHoverIdx,
}: TimeSeriesChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[300px] text-sm text-slate-500">
        Loading time series…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
        Could not load time series: {error}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
        No performance records yet at this location.
      </div>
    );
  }

  const W = 880;
  const H = 320;
  const M = { top: 18, right: 24, bottom: 44, left: 48 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;

  const xToPx = (i: number) =>
    M.left + (rows.length <= 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);
  const yToPx = (y: number) => M.top + innerH - (y / 100) * innerH;

  // Band rects span the full plot width.
  const bandRects: Array<{ from: number; to: number; band: Exclude<LocationCsBand, "no_data"> }> = [
    { from: CS_SCORE_GREEN_MIN, to: 100, band: "green" },
    { from: CS_SCORE_YELLOW_MIN, to: CS_SCORE_GREEN_MIN, band: "yellow" },
    { from: 0, to: CS_SCORE_YELLOW_MIN, band: "red" },
  ];

  // Build polyline points; null breaks the line.
  const segs: string[] = [];
  let cur: string[] = [];
  rows.forEach((r, i) => {
    if (r.score === null) {
      if (cur.length > 1) segs.push(cur.join(" "));
      cur = [];
    } else {
      cur.push(`${xToPx(i)},${yToPx(r.score)}`);
    }
  });
  if (cur.length > 1) segs.push(cur.join(" "));

  const yTicks = [0, 20, 40, 60, 70, 85, 100];
  const hovered = hoverIdx !== null ? rows[hoverIdx] : null;

  return (
    <div className="space-y-3">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={`Customer Service Score over time for ${locationName}`}
      >
        {/* Threshold band fills */}
        {bandRects.map((b) => (
          <rect
            key={b.band}
            x={M.left}
            y={yToPx(b.to)}
            width={innerW}
            height={yToPx(b.from) - yToPx(b.to)}
            fill={BAND_BG[b.band]}
            opacity={0.6}
          />
        ))}

        {/* Plot border */}
        <rect
          x={M.left}
          y={M.top}
          width={innerW}
          height={innerH}
          fill="none"
          stroke="#E2E8F0"
        />

        {/* Y axis ticks + threshold rules at 70 / 85 */}
        {yTicks.map((t) => (
          <g key={`y-${t}`}>
            <line
              x1={M.left}
              x2={M.left + innerW}
              y1={yToPx(t)}
              y2={yToPx(t)}
              stroke={t === 70 || t === 85 ? "#64748B" : "#E2E8F0"}
              strokeDasharray={t === 70 || t === 85 ? "4 3" : undefined}
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
              {t}
            </text>
          </g>
        ))}

        {/* X axis labels */}
        {rows.map((r, i) => (
          <text
            key={`x-${i}`}
            x={xToPx(i)}
            y={M.top + innerH + 16}
            textAnchor="middle"
            fontSize={10}
            fill="#64748B"
          >
            {r.period_label}
          </text>
        ))}

        {/* Connecting line */}
        {segs.map((seg, i) => (
          <polyline
            key={`seg-${i}`}
            points={seg}
            fill="none"
            stroke={LINE_COLOR}
            strokeWidth={2}
          />
        ))}

        {/* Per-point markers (skipped when score is null) */}
        {rows.map((r, i) => {
          if (r.score === null) return null;
          const isHover = hoverIdx === i;
          return (
            <circle
              key={`pt-${i}`}
              cx={xToPx(i)}
              cy={yToPx(r.score)}
              r={isHover ? 5.5 : 4}
              fill={BAND_FILL[r.band]}
              stroke="#FFFFFF"
              strokeWidth={1.5}
            />
          );
        })}

        {/* Vertical hover marker */}
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

        {/* Wide hover bands across each quarter slot */}
        {rows.map((_, i) => {
          const bandW = rows.length > 1 ? innerW / (rows.length - 1) : innerW;
          return (
            <rect
              key={`hover-${i}`}
              x={xToPx(i) - bandW / 2}
              y={M.top}
              width={bandW}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => onHoverIdx(i)}
              onMouseLeave={() => onHoverIdx(null)}
              style={{ cursor: "crosshair" }}
            />
          );
        })}

        {/* Y axis title */}
        <text
          x={14}
          y={M.top + innerH / 2}
          textAnchor="middle"
          fontSize={11}
          fill="#0F172A"
          transform={`rotate(-90 14 ${M.top + innerH / 2})`}
        >
          CS Score
        </text>
      </svg>

      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 min-h-[52px]">
        {hovered ? (
          <div className="flex flex-wrap gap-x-6 gap-y-1 items-center">
            <span className="font-semibold text-slate-900">
              {hovered.period_label}
            </span>
            <span>
              <span className="text-slate-500">Score: </span>
              <span style={{ color: BAND_FILL[hovered.band], fontWeight: 600 }}>
                {formatLocationCsScore(hovered.score)}
              </span>
            </span>
            <span
              className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] ${bandPillClasses(
                hovered.band
              )}`}
            >
              {BAND_LABEL[hovered.band]}
            </span>
          </div>
        ) : (
          <span className="text-slate-500">
            Hover a quarter to see its score and band.
          </span>
        )}
      </div>

      <Legend />
    </div>
  );
}

// ============================================================================
// Multi-location sub-chart (horizontal bars)
// ============================================================================

interface MultiLocationChartProps {
  rows: LocationCsScore[];
  loading: boolean;
  error: string | null;
  quarters: Array<{ id: string; label: string }>;
  selectedQuarterId: string;
  onSelectQuarter: (id: string) => void;
  currentLocationId: string;
  hoverId: string | null;
  onHoverId: (id: string | null) => void;
}

function MultiLocationChart({
  rows,
  loading,
  error,
  quarters,
  selectedQuarterId,
  onSelectQuarter,
  currentLocationId,
  hoverId,
  onHoverId,
}: MultiLocationChartProps) {
  const headerControls = (
    <div className="flex items-center gap-2">
      <label className="text-xs uppercase tracking-wide text-slate-500">
        Quarter
      </label>
      <select
        value={selectedQuarterId}
        onChange={(e) => onSelectQuarter(e.target.value)}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm min-w-[140px]"
      >
        {quarters.map((q) => (
          <option key={q.id} value={q.id}>
            {q.label}
          </option>
        ))}
      </select>
    </div>
  );

  if (quarters.length === 0) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
        No quarters available yet.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {headerControls}
        <div className="flex items-center justify-center h-[280px] text-sm text-slate-500">
          Loading multi-location snapshot…
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-3">
        {headerControls}
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          Could not load snapshot: {error}
        </div>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="space-y-3">
        {headerControls}
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
          No locations to compare for this quarter.
        </div>
      </div>
    );
  }

  const ROW_H = 30;
  const LABEL_W = 200;
  const W = 880;
  const innerW = W - LABEL_W - 64; // label + right padding for score text
  const H = rows.length * ROW_H + 20;

  const xToPx = (score: number) => LABEL_W + (score / 100) * innerW;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {headerControls}
        <span className="text-xs text-slate-500">
          {rows.length} location{rows.length === 1 ? "" : "s"}, ranked by score.
          Bars stop at 100.
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label="Customer Service Score by location for the selected quarter"
      >
        {/* Threshold guideline rules */}
        <line
          x1={xToPx(CS_SCORE_GREEN_MIN)}
          x2={xToPx(CS_SCORE_GREEN_MIN)}
          y1={0}
          y2={H}
          stroke="#15803D"
          strokeWidth={0.5}
          strokeDasharray="3 3"
        />
        <line
          x1={xToPx(CS_SCORE_YELLOW_MIN)}
          x2={xToPx(CS_SCORE_YELLOW_MIN)}
          y1={0}
          y2={H}
          stroke="#B91C1C"
          strokeWidth={0.5}
          strokeDasharray="3 3"
        />

        {rows.map((r, i) => {
          const y = i * ROW_H + 4;
          const barH = ROW_H - 10;
          const isHover = hoverId === r.location_id;
          const isCurrent = r.location_id === currentLocationId;
          const barW =
            r.score === null ? 0 : Math.max(2, xToPx(r.score) - LABEL_W);
          const labelText =
            r.score === null
              ? "—"
              : `${formatLocationCsScore(r.score)} · ${BAND_LABEL[r.band]}`;
          return (
            <g
              key={r.location_id}
              onMouseEnter={() => onHoverId(r.location_id)}
              onMouseLeave={() => onHoverId(null)}
              style={{ cursor: "pointer" }}
            >
              {/* Row hit area */}
              <rect
                x={0}
                y={i * ROW_H}
                width={W}
                height={ROW_H}
                fill={isHover ? "#0F172A0A" : "transparent"}
              />
              {/* Name */}
              <text
                x={LABEL_W - 8}
                y={y + barH / 2 + 1}
                textAnchor="end"
                dominantBaseline="central"
                fontSize={11}
                fontWeight={isCurrent ? 700 : 500}
                fill={isCurrent ? "#0F172A" : "#1E293B"}
              >
                {isCurrent ? `▸ ${r.location_name}` : r.location_name}
              </text>
              {/* Bar (only if score present) */}
              {r.score !== null && (
                <rect
                  x={LABEL_W}
                  y={y}
                  width={barW}
                  height={barH}
                  fill={BAND_FILL[r.band]}
                  opacity={hoverId && !isHover ? 0.4 : 0.9}
                  rx={2}
                />
              )}
              {/* Score label */}
              <text
                x={r.score !== null ? LABEL_W + barW + 6 : LABEL_W + 6}
                y={y + barH / 2 + 1}
                textAnchor="start"
                dominantBaseline="central"
                fontSize={10}
                fontWeight={isHover ? 700 : 600}
                fill={r.score === null ? "#94A3B8" : BAND_FILL[r.band]}
              >
                {labelText}
              </text>
            </g>
          );
        })}
      </svg>

      <Legend />
    </div>
  );
}

// ============================================================================
// Shared legend
// ============================================================================
function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600">
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-3 w-3 rounded-sm"
          style={{ background: BAND_FILL.green }}
        />
        ≥{CS_SCORE_GREEN_MIN} Exceeds
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-3 w-3 rounded-sm"
          style={{ background: BAND_FILL.yellow }}
        />
        {CS_SCORE_YELLOW_MIN}–{CS_SCORE_GREEN_MIN - 1} Meets
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-3 w-3 rounded-sm"
          style={{ background: BAND_FILL.red }}
        />
        &lt;{CS_SCORE_YELLOW_MIN} Below
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-3 w-3 rounded-sm"
          style={{ background: BAND_FILL.no_data }}
        />
        No data
      </span>
    </div>
  );
}
