/**
 * Location-Level CS Score — rolls the per-employee Phase 9 CS Score up to
 * the location level (hours-weighted average, same eligibility as Phase 10
 * TIS rankings: active + ≥40 all-time worked hours at the location).
 *
 * Mirrors the SQL functions in migration 026:
 *   - compute_location_cs_score(location_id, report_period_id) → numeric
 *   - compute_location_cs_score_time_series(location_id) → table
 *   - compute_location_cs_score_multi_location(report_period_id) → table
 *
 * Thresholds + band semantics are reused from src/lib/customer-service-score.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CS_SCORE_GREEN_MIN,
  CS_SCORE_YELLOW_MIN,
  type CsScoreTone,
} from "./customer-service-score";

export type LocationCsBand = "green" | "yellow" | "red" | "no_data";

export interface LocationCsScore {
  location_id: string;
  location_name: string;
  report_period_id: string;
  period_label: string;
  period_start: string; // YYYY-MM-DD
  period_end: string;   // YYYY-MM-DD
  score: number | null;
  band: LocationCsBand;
}

export function classifyLocationCsScore(score: number | null): LocationCsBand {
  if (score === null || !Number.isFinite(score)) return "no_data";
  if (score >= CS_SCORE_GREEN_MIN) return "green";
  if (score >= CS_SCORE_YELLOW_MIN) return "yellow";
  return "red";
}

/** Map the band to the existing CS Score tone vocabulary so badges/colors line up. */
export function toneForLocationCsScore(score: number | null): CsScoreTone {
  const band = classifyLocationCsScore(score);
  return band === "no_data" ? "muted" : band;
}

/** Display-rounded composite (whole numbers, matches per-employee CS Score). */
export function formatLocationCsScore(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return "—";
  return Math.round(score).toString();
}

function toNumOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Single-value form — used for hand-reconciliation + targeted lookups.
 * Returns null when no eligible employee has both a non-null CS Score AND
 * positive quarter hours at this location.
 */
export async function computeLocationCsScoreForQuarter(
  supabase: SupabaseClient,
  locationId: string,
  reportPeriodId: string
): Promise<number | null> {
  const { data, error } = await supabase.rpc("compute_location_cs_score", {
    p_location_id: locationId,
    p_report_period_id: reportPeriodId,
  });
  if (error) throw error;
  return toNumOrNull(data as number | string | null);
}

/**
 * Time series for one location across every quarter that has any
 * performance_records for it. Returned chronologically ascending.
 */
export async function computeLocationCsScoreTimeSeries(
  supabase: SupabaseClient,
  locationId: string,
  locationName: string
): Promise<LocationCsScore[]> {
  const { data, error } = await supabase.rpc(
    "compute_location_cs_score_time_series",
    { p_location_id: locationId }
  );
  if (error) throw error;
  type Row = {
    report_period_id: string;
    period_label: string;
    period_start: string;
    period_end: string;
    score: number | string | null;
  };
  return ((data ?? []) as Row[]).map((r) => {
    const score = toNumOrNull(r.score);
    return {
      location_id: locationId,
      location_name: locationName,
      report_period_id: r.report_period_id,
      period_label: r.period_label,
      period_start: r.period_start,
      period_end: r.period_end,
      score,
      band: classifyLocationCsScore(score),
    };
  });
}

/**
 * All active locations' scores for a single quarter, sorted by score desc
 * (NULLs last) per the SQL function's ORDER BY.
 */
export async function computeMultiLocationCsScoreForQuarter(
  supabase: SupabaseClient,
  reportPeriodId: string,
  periodLabel: string,
  periodStart: string,
  periodEnd: string
): Promise<LocationCsScore[]> {
  const { data, error } = await supabase.rpc(
    "compute_location_cs_score_multi_location",
    { p_report_period_id: reportPeriodId }
  );
  if (error) throw error;
  type Row = {
    location_id: string;
    location_name: string;
    score: number | string | null;
  };
  return ((data ?? []) as Row[]).map((r) => {
    const score = toNumOrNull(r.score);
    return {
      location_id: r.location_id,
      location_name: r.location_name,
      report_period_id: reportPeriodId,
      period_label: periodLabel,
      period_start: periodStart,
      period_end: periodEnd,
      score,
      band: classifyLocationCsScore(score),
    };
  });
}
