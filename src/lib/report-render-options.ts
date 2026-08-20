/**
 * Report-builder metric selection → PDF row rendering (kickoff 2026-08-19 §3,
 * §5-B locked: compute-always, render-conditionally).
 *
 * The builder's checkboxes select GROUPS (one checkbox can govern several
 * related PDF rows); this module expands the selection to the concrete
 * EmployeeReport METRIC_DEFS keys. Review + Tattle rows are governed by their
 * own dedicated toggles (§3 "Review/Tattle display toggles"), so they are NOT
 * in the group list — the effective render set is groups ∪ toggles.
 *
 * `null` means "render everything" — returned when the whole selection is on,
 * so a default submission is byte-identical to today's PDF and the audit
 * snapshot records "no restriction" rather than a 20-key list.
 *
 * Pure module — server-safe by design; shared by the builder UI (labels),
 * the server action (expansion), and pinned by unit tests. The keys MUST
 * mirror EmployeeReport.tsx METRIC_DEFS — the colocated test cross-checks.
 */

export interface MetricGroup {
  id: string;
  label: string;
  keys: readonly string[];
}

export const METRIC_GROUPS: readonly MetricGroup[] = [
  { id: "on_time", label: "On Time %", keys: ["on_time_pct"] },
  { id: "attendance", label: "Attendance %", keys: ["attendance_pct"] },
  { id: "covered_shifts", label: "Covered Shifts", keys: ["covered_shifts"] },
  { id: "survey_engagement", label: "Survey Engagement %", keys: ["survey_engagement_pct"] },
  {
    id: "task_list_completion",
    label: "Avg Task-List Completion %",
    keys: ["avg_task_list_completion_pct"],
  },
  {
    id: "tip_rate",
    label: "Tip Rate % (+ vs store average)",
    keys: ["tip_rate_pct", "tip_rate_delta_pp"],
  },
  { id: "tip_per_hour", label: "Tip / Hour", keys: ["tip_per_hour"] },
  {
    id: "kitchen",
    label: "Kitchen Speed",
    keys: [
      "kitchen_residual_seconds",
      "kitchen_avg_prep_seconds",
      "kitchen_baseline_prep_seconds",
      "kitchen_tickets",
    ],
  },
  {
    // Excluding the composite row also hides the Customer Service breakdown
    // sub-section (they explain each other; one without the other is noise).
    id: "customer_service_score",
    label: "Customer Service Score (+ breakdown)",
    keys: ["customer_service_score"],
  },
] as const;

/** Rows governed by the dedicated Online-Reviews display toggle. */
export const REVIEW_KEYS: readonly string[] = [
  "customer_service_rating",
  "customer_review_quantity",
];

/** Rows governed by the dedicated Tattle display toggle. */
export const TATTLE_KEYS: readonly string[] = [
  "tattle_rating",
  "tattle_quantity",
  "tattle_score_food_quality",
  "tattle_score_accuracy",
  "tattle_score_speed_of_service",
];

/** Per-PDF render options, threaded action → ReportData (§5-B / §5-C). */
export interface ReportRenderOptions {
  /** METRIC_DEFS keys allowed to render; null = no restriction (all rows). */
  included_metric_keys: string[] | null;
  /** §5-C: render the Manager Feedback section on THIS PDF (never deletes stored text). */
  include_manager_feedback: boolean;
}

/**
 * Expand the builder's selection into concrete metric keys. Unknown group ids
 * are ignored (stale form / hand-edited POST degrade to fewer rows, never an
 * error). Returns null when everything is selected.
 */
export function resolveIncludedMetricKeys(
  selectedGroupIds: string[],
  includeReviews: boolean,
  includeTattles: boolean
): string[] | null {
  const selected = new Set(selectedGroupIds);
  const allGroupsOn = METRIC_GROUPS.every((g) => selected.has(g.id));
  if (allGroupsOn && includeReviews && includeTattles) return null;

  const keys: string[] = [];
  for (const g of METRIC_GROUPS) {
    if (selected.has(g.id)) keys.push(...g.keys);
  }
  if (includeReviews) keys.push(...REVIEW_KEYS);
  if (includeTattles) keys.push(...TATTLE_KEYS);
  return keys;
}
