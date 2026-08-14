/**
 * Loader + canonical key list for `metric_targets` (mig 051, 2026-08-14
 * targets sprint). Targets are cross-app contract values mirrored in
 * Training HQ (their side is migration-config) — any change ships BOTH
 * sides as a paired Tucker-approved update, never an EPD-only edit.
 *
 * Nine rows, loaded server-side per page/report render — a single query, no
 * caching cleverness. Missing rows stay missing in the returned map so
 * classification fails visible (classifyVsTarget → null), never falls back
 * to a hardcoded value.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TargetMetricKey } from "./types";
import type { MetricTargets } from "./classify";

/**
 * Canonical ordered list of the nine target-driven metrics. Must match the
 * migration 051 CHECK set exactly (pinned by metric-targets-contract.test.ts)
 * and the TargetMetricKey union. `scale` drives editor validation + hints:
 * ratings are native 1–5, everything else 0–100.
 */
export const TARGET_METRICS: ReadonlyArray<{
  key: TargetMetricKey;
  label: string;
  scale: "rating" | "percent";
}> = [
  { key: "on_time_grace_pct", label: "On-Time % (3-min grace)", scale: "percent" },
  { key: "attendance_pct", label: "Attendance %", scale: "percent" },
  { key: "survey_engagement_pct", label: "Survey Engagement %", scale: "percent" },
  // Display name diverges from the customer_service_rating column name
  // deliberately (2026-08-14 rename) — wire/DB names untouched.
  { key: "customer_service_rating", label: "Online Review Rating", scale: "rating" },
  { key: "tattle_rating", label: "Tattle Rating", scale: "rating" },
  { key: "tattle_score_food_quality", label: "Tattle — Food Quality", scale: "percent" },
  { key: "tattle_score_accuracy", label: "Tattle — Accuracy", scale: "percent" },
  { key: "tattle_score_speed_of_service", label: "Tattle — Speed of Service", scale: "percent" },
  { key: "avg_task_list_completion_pct", label: "Avg Task-List Completion %", scale: "percent" },
];

export const TARGET_METRIC_KEYS: ReadonlyArray<TargetMetricKey> =
  TARGET_METRICS.map((m) => m.key);

/**
 * Fetch all metric targets as a key → target map. On query error returns an
 * EMPTY map (every classification renders as unclassified) rather than
 * throwing — a broken config table should degrade the badges, not take down
 * the page or the PDF render.
 */
export async function fetchMetricTargets(
  supabase: SupabaseClient
): Promise<MetricTargets> {
  const { data, error } = await supabase
    .from("metric_targets")
    .select("metric_key, target");
  const targets: MetricTargets = {};
  if (error || !data) {
    console.error("[metric-targets] fetch failed", { message: error?.message });
    return targets;
  }
  const known = new Set<string>(TARGET_METRIC_KEYS);
  for (const row of data) {
    const key = row.metric_key as string;
    if (!known.has(key)) continue;
    const n =
      typeof row.target === "string" ? Number(row.target) : (row.target as number);
    if (Number.isFinite(n)) targets[key as TargetMetricKey] = n;
  }
  return targets;
}
