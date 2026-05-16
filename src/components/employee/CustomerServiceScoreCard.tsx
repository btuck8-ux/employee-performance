"use client";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  classifyCustomerServiceScore,
  computeCustomerServiceScoreBreakdown,
  formatCustomerServiceScore,
  toneForCustomerServiceScore,
  type CsScoreTone,
  type CustomerServiceWeights,
} from "@/lib/customer-service-score";
import { formatDeltaPP, formatRating } from "@/lib/format";

export interface CustomerServiceScoreQuarterRow {
  performance_record_id: string;
  label: string;
  period_start: string;
  /** Stored composite — null if persisted as null, or recomputed lazily client-side. */
  customer_service_score: number | null;
  customer_service_score_components_count: number | null;
  tattle_rating: number | null;
  tattle_quantity: number | null;
  customer_service_rating: number | null;
  customer_review_quantity: number | null;
  tip_rate_delta_pp: number | null;
}

interface Props {
  quarters: CustomerServiceScoreQuarterRow[];
  weights: CustomerServiceWeights;
}

/**
 * Dashboard tile for the Customer Service Score (Phase 9). Renders the most
 * recent quarter by default; a dropdown lets the user pick another quarter.
 * The composite tile is click-to-expand: clicking flips open a breakdown panel
 * with each component's native value, normalized 0–100 score, and band badge.
 *
 * Null composite (0 or 1 of 3 present) shows an em-dash with the appropriate
 * "Insufficient data" / "Single-source" annotation per spec.
 */
export function CustomerServiceScoreCard({ quarters, weights }: Props) {
  const sorted = useMemo(() => {
    return [...quarters].sort((a, b) =>
      b.period_start.localeCompare(a.period_start)
    );
  }, [quarters]);

  const [selectedId, setSelectedId] = useState<string>(
    sorted[0]?.performance_record_id ?? ""
  );
  const [expanded, setExpanded] = useState(false);

  const current =
    sorted.find((r) => r.performance_record_id === selectedId) ?? sorted[0];

  // Recompute breakdown client-side so we don't have to round-trip the SQL
  // function for every quarter the user clicks through. Matches the math in
  // migration 023 / src/lib/customer-service-score.ts.
  const breakdown = useMemo(() => {
    if (!current) return null;
    return computeCustomerServiceScoreBreakdown(
      current.tattle_rating,
      current.customer_service_rating,
      current.tip_rate_delta_pp,
      weights
    );
  }, [current, weights]);

  if (!current || !breakdown) {
    return (
      <p className="text-sm text-slate-500">
        No performance records yet. Customer Service Score will populate once
        underlying data is ingested.
      </p>
    );
  }

  const composite = breakdown.composite_score;
  const tone = toneForCustomerServiceScore(composite);
  const label = classifyCustomerServiceScore(composite);
  const cnt = breakdown.components_count;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-slate-500 flex items-center gap-2">
          Quarter
          <select
            value={current.performance_record_id}
            onChange={(e) => {
              setSelectedId(e.target.value);
              setExpanded(false);
            }}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            {sorted.map((r) => (
              <option key={r.performance_record_id} value={r.performance_record_id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-slate-500">
          Weights: Tattle {(weights.weight_tattle * 100).toFixed(0)}% · Reviews{" "}
          {(weights.weight_reviews * 100).toFixed(0)}% · Tip{" "}
          {(weights.weight_tip * 100).toFixed(0)}%
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
        } px-4 py-4 hover:shadow-sm transition-shadow`}
        aria-expanded={expanded}
      >
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">
              Customer Service Score
            </p>
            <div className="flex items-baseline gap-3 mt-1">
              {composite !== null ? (
                <>
                  <span className="text-4xl font-semibold tabular-nums">
                    {formatCustomerServiceScore(composite)}
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
              ) : cnt === 1 ? (
                <SingleSourceHeadline row={current} breakdown={breakdown} />
              ) : (
                <>
                  <span className="text-4xl font-semibold tabular-nums text-slate-400">
                    —
                  </span>
                  <span
                    className="text-xs text-slate-500"
                    title="Need at least 2 of 3 components (Tattle, Reviews, Tip) to produce a composite."
                  >
                    Insufficient data this quarter
                  </span>
                </>
              )}
            </div>
            {composite !== null && cnt === 2 && (
              <p className="text-xs text-slate-600 mt-1.5">
                Computed from 2 of 3 components (one missing — re-weighted pro-rata).
              </p>
            )}
          </div>
          <span className="text-xs text-slate-500">
            {expanded ? "Hide breakdown ▴" : "Show breakdown ▾"}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="rounded-md border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-2">
            <p className="text-xs text-slate-500 uppercase tracking-wide">
              Component breakdown · {current.label}
            </p>
          </div>
          <ComponentRow
            name="Tattle rating"
            nativeDisplay={`${formatRating(current.tattle_rating)} / 5`}
            extra={
              current.tattle_quantity
                ? `${current.tattle_quantity} survey${current.tattle_quantity === 1 ? "" : "s"}`
                : "No surveys"
            }
            score={breakdown.tattle_component_score}
            effectiveWeight={breakdown.effective_weight_tattle}
            configuredWeight={weights.weight_tattle}
            compositeComputed={composite !== null}
          />
          <ComponentRow
            name="Customer reviews"
            nativeDisplay={`${formatRating(current.customer_service_rating)} / 5`}
            extra={
              current.customer_review_quantity
                ? `${current.customer_review_quantity} review${current.customer_review_quantity === 1 ? "" : "s"}`
                : "No reviews"
            }
            score={breakdown.reviews_component_score}
            effectiveWeight={breakdown.effective_weight_reviews}
            configuredWeight={weights.weight_reviews}
            compositeComputed={composite !== null}
          />
          <ComponentRow
            name="Tip-rate delta"
            nativeDisplay={formatDeltaPP(current.tip_rate_delta_pp)}
            extra="vs location avg (±2pp window)"
            score={breakdown.tip_component_score}
            effectiveWeight={breakdown.effective_weight_tip}
            configuredWeight={weights.weight_tip}
            compositeComputed={composite !== null}
            isLast
          />
          <div className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
            Same 0–100 normalization applies to each component. Green ≥85,
            Yellow 70–&lt;85, Red &lt;70. The tip component uses a ±2pp window;
            a +0.8pp delta = 70 (yellow threshold), +1.4pp = 85 (green
            threshold). This is intentionally different from the dashboard tip
            badge (±0.25pp neutral band) — same signal, two yardsticks.
          </div>
        </div>
      )}
    </div>
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
  const tone = toneForCustomerServiceScore(score);
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
            {formatCustomerServiceScore(score)}
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

function ToneDot({ tone }: { tone: CsScoreTone }) {
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

/**
 * Headline used when exactly one of the three components is present. Per spec,
 * this is NOT a composite — it's the single source's native value with a
 * "single-source" annotation, clearly distinguished from a true CS Score.
 */
function SingleSourceHeadline({
  row,
  breakdown,
}: {
  row: CustomerServiceScoreQuarterRow;
  breakdown: ReturnType<typeof computeCustomerServiceScoreBreakdown>;
}) {
  let sourceLabel: string;
  let nativeDisplay: string;
  let score: number | null;
  if (breakdown.tattle_component_score !== null) {
    sourceLabel = "Tattle only";
    nativeDisplay = `${formatRating(row.tattle_rating)} / 5`;
    score = breakdown.tattle_component_score;
  } else if (breakdown.reviews_component_score !== null) {
    sourceLabel = "Reviews only";
    nativeDisplay = `${formatRating(row.customer_service_rating)} / 5`;
    score = breakdown.reviews_component_score;
  } else {
    sourceLabel = "Tip-delta only";
    nativeDisplay = formatDeltaPP(row.tip_rate_delta_pp);
    score = breakdown.tip_component_score;
  }
  return (
    <>
      <span className="text-3xl font-semibold tabular-nums">
        {nativeDisplay}
      </span>
      <span className="text-slate-500 text-sm">
        Single-source ({sourceLabel}) · normalized {formatCustomerServiceScore(score)}/100
      </span>
    </>
  );
}
