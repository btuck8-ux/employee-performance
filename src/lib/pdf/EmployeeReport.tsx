/* eslint-disable jsx-a11y/alt-text */
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from "@react-pdf/renderer";
import { classifyFixed } from "@/lib/classify";
import {
  classifyCustomerServiceScore,
  computeCustomerServiceScoreBreakdown,
  DEFAULT_CS_WEIGHTS,
  formatCustomerServiceScore,
  type CustomerServiceScoreBreakdown,
  type CustomerServiceWeights,
} from "@/lib/customer-service-score";
import {
  formatHireDate,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatRating,
  formatTenure,
} from "@/lib/format";
import type { ExpectationLabel, FixedMetricKey } from "@/lib/types";
import {
  staleCategories,
  type CategoryCurrencyEntry,
} from "@/lib/category-currency";

// 1.1.0 added Δ + sparkline + trend page. 1.2.0 dropped the sparkline/trend
// page. 1.3.0 (Phase 7b) adds presence-based tip metrics — tip rate, tip per
// hour, and tip-rate-vs-location-average — driven by 2025 POS sales ingest.
// Tip rows render only when the underlying data is present; locations without
// POS data still produce a clean report without empty tip rows.
// 1.4.0 (Phase 9) adds the Customer Service Score composite row + breakdown
// sub-section; the row + sub-section auto-hide when the composite is null.
// 1.5.0 adds the Kitchen Speed block (Toast Kitchen feed) — avg prep time vs
// the store average + attributed ticket count. Reported metric, NOT a scored
// component (CS/TIS weights unchanged); rows render only at >= 25 attributed
// tickets so a thin sample never prints as a number.
// 1.5.1 (043 redesign) reframes Kitchen Speed as a shared shift outcome:
// attribution is on-the-clock overlap with no role filter, the comparison is
// the hour-matched residual vs the store's own norm (not a flat store
// average), and the block leads with "vs norm" — the only hour-fair number.
// Suppressed below 15 attributed shifts (day-to-day residual SD ~114s).
// 1.5.2 removes the 15-shift floor as a GATE and retains it as ADVISORY:
// the block always renders when kitchen data exists, at any shift count —
// the number is real at every n (SE ~114/sqrt(shifts)), only its precision
// varies, and thin-sample judgment belongs to the human reader. Below 15
// shifts the rating badge is withheld (an automated verdict would pass
// exactly the judgment humans are supposed to withhold) and the footnote
// flags the figures as directional only.
export const TEMPLATE_VERSION = "1.5.2";

const COLORS = {
  exceedsBg: "#CCFFCC",
  meetsBg: "#FFF2CC",
  belowBg: "#F4CCCC",
  text: "#000000",
  rule: "#E2E8F0",
  muted: "#64748B",
  positive: "#15803D", // emerald-700, used for + deltas
  negative: "#B91C1C", // red-700, used for - deltas
  bar: "#94A3B8",      // slate-400, sparkline bars
  barCurrent: "#1E293B", // slate-800, sparkline current quarter
  chartBar: "#3B82F6", // blue-500, trend page bars
};

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 11, fontFamily: "Helvetica", color: COLORS.text },
  h1: { fontSize: 22, fontWeight: 700, marginBottom: 4 },
  subtitle: { fontSize: 11, color: COLORS.muted, marginBottom: 16 },
  hr: { borderBottomWidth: 1, borderBottomColor: COLORS.rule, marginVertical: 12 },
  headerGrid: { flexDirection: "row", flexWrap: "wrap", marginBottom: 8 },
  headerCell: { width: "50%", marginBottom: 6 },
  label: { fontSize: 9, color: COLORS.muted, marginBottom: 2 },
  value: { fontSize: 12 },
  sectionTitle: { fontSize: 13, fontWeight: 700, marginTop: 12, marginBottom: 8 },
  currencyBlock: { marginTop: 6 },
  currencyBanner: {
    fontSize: 8,
    color: "#92400e",
    backgroundColor: "#fef3c7",
    padding: 4,
    borderRadius: 2,
    marginBottom: 3,
  },
  currencyLine: { fontSize: 7, color: "#6b7280" },
  table: { borderWidth: 1, borderColor: COLORS.rule, borderRadius: 4 },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#F1F5F9",
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.rule,
  },
  tableHeaderCell: { fontSize: 9, fontWeight: 700, color: COLORS.muted },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.rule,
    alignItems: "center",
  },
  tableRowLast: {
    flexDirection: "row",
    paddingVertical: 6,
    paddingHorizontal: 8,
    alignItems: "center",
  },
  // Four columns: Metric · Value · Δ · Notes. The Trend (4Q) column was
  // removed in v1.2.0; freeing up the space lets the Δ column breathe so
  // a value like "+13.89pp" no longer wraps.
  metricCol: { flex: 4 },
  valueCol: { flex: 2 },
  deltaCol: { flex: 2 },
  notesCol: { flex: 3 },
  badge: {
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 3,
    fontSize: 9,
  },
  feedbackBox: {
    borderWidth: 1,
    borderColor: COLORS.rule,
    borderRadius: 4,
    padding: 12,
    minHeight: 80,
  },
  // ---- Phase 9: Customer Service breakdown sub-section ----
  breakdownTable: {
    borderWidth: 1,
    borderColor: COLORS.rule,
    borderRadius: 4,
  },
  breakdownHeader: {
    flexDirection: "row",
    backgroundColor: "#F1F5F9",
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.rule,
  },
  breakdownRow: {
    flexDirection: "row",
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.rule,
    alignItems: "center",
  },
  breakdownRowLast: {
    flexDirection: "row",
    paddingVertical: 5,
    paddingHorizontal: 8,
    alignItems: "center",
  },
  bdComponentCol: { flex: 4 },
  bdNativeCol: { flex: 2 },
  bdScoreCol: { flex: 2 },
  bdBadgeCol: { flex: 3 },
  legendBox: {
    marginTop: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: "#F8FAFC",
    borderRadius: 3,
    fontSize: 8,
    color: COLORS.muted,
    lineHeight: 1.4,
  },
  signatureRow: { flexDirection: "row", marginTop: 14 },
  sigSignatureCol: { flex: 3, marginRight: 16 },
  sigDateCol: { flex: 2 },
  sigLine: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.text,
    height: 24,
  },
  sigLabel: { fontSize: 9, color: COLORS.muted, marginTop: 3 },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 36,
    right: 36,
    fontSize: 8,
    color: COLORS.muted,
    textAlign: "center",
  },
});

function badgeStyle(label: ExpectationLabel | null) {
  if (!label) return { backgroundColor: "#F8FAFC", color: COLORS.muted };
  if (label === "Exceeds Expectations")
    return { backgroundColor: COLORS.exceedsBg, color: COLORS.text };
  if (label === "Meets Expectations")
    return { backgroundColor: COLORS.meetsBg, color: COLORS.text };
  return { backgroundColor: COLORS.belowBg, color: COLORS.text };
}

// ---- Types ----

export interface MetricSnapshot {
  on_time_pct: number | null;
  attendance_pct: number | null;
  covered_shifts: number | null;
  survey_engagement_pct: number | null;
  surveys_assigned: number | null;
  surveys_completed: number | null;
  customer_service_rating: number | null;
  customer_review_quantity: number | null;
  tattle_rating: number | null;
  tattle_quantity: number | null;
  tattle_score_food_quality: number | null;
  tattle_score_accuracy: number | null;
  tattle_score_speed_of_service: number | null;
  // Phase 7b: presence-based tip metrics. All five null when no POS data
  // covered this period at the employee's location.
  tip_rate_pct: number | null;
  tip_per_hour: number | null;
  location_tip_rate_pct: number | null;
  location_tip_per_hour: number | null;
  tip_rate_delta_pp: number | null;
  // Phase 9: composite customer service score (0–100). Null when fewer than
  // 2 of 3 components were present; the row + breakdown sub-section auto-hide
  // in that case.
  customer_service_score: number | null;
  customer_service_score_components_count: number | null;
  // 1.5.1/1.5.2: Kitchen Speed v2 (043). All null only when the employee had
  // no attributed items in the window (never on the clock at a
  // kitchen-enabled store, kitchen-disabled store, or pre-Toast-go-live
  // period) — present at any shift count otherwise (1.5.2).
  // baseline = the store's volume-weighted same-hour norm (avg - residual).
  kitchen_items: number | null;
  kitchen_tickets: number | null;
  kitchen_shifts: number | null;
  kitchen_avg_prep_seconds: number | null;
  kitchen_baseline_prep_seconds: number | null;
  kitchen_residual_seconds: number | null;
}

export interface TrailingQuarter {
  label: string;        // e.g., "Q1 2026"
  period_start: string; // e.g., "2026-01-01"
  metrics: MetricSnapshot;
}

export interface ReportData {
  employee_name: string;
  employee_code: string;
  location_name: string;
  hire_date: string | null;
  report_period_label: string;
  report_period_end: string;
  metrics: MetricSnapshot;
  manager_feedback: string | null;
  generated_at: string;
  /**
   * Trailing quarters' snapshots, sorted OLDEST → NEWEST. The current
   * report's quarter is the LAST element. The element BEFORE the last is
   * the prior quarter (used for Δ). Up to 4 elements are expected; fewer
   * is fine (e.g., a brand-new quarter may only have itself). Omit
   * entirely for custom-range reports — the trend page is gated on this
   * being present with length > 1.
   */
  trailing_quarters?: TrailingQuarter[];
  /**
   * Phase 9: weights used when computing this report's composite. Used to
   * render the per-component breakdown sub-section. Omit and the renderer
   * falls back to defaults (0.40/0.40/0.20).
   */
  customer_service_weights?: CustomerServiceWeights;
  /**
   * Per-category "data through" stamps (category-currency.ts). When present,
   * a compact currency line renders under the metrics table and a staleness
   * banner appears if any category's newest data trails min(period_end,
   * today) by more than STALE_AFTER_DAYS. Null data_through (a category this
   * location never ingests, e.g. NOLA sales) renders neutrally as "—".
   */
  category_currency?: CategoryCurrencyEntry[];
}

// ---- Metric kind table ----

type MetricKind =
  | "pct"
  | "rating"
  | "count"
  | "money"
  | "delta_pp"
  | "score_100"
  | "duration"
  | "delta_duration";

interface MetricDef {
  key: keyof MetricSnapshot;
  name: string;
  kind: MetricKind;
  /** Use one of the legacy fixed-threshold buckets for the Notes column. */
  classify?: FixedMetricKey;
  /**
   * Callback-driven classifier for metrics whose "expectation" isn't a fixed
   * threshold (e.g., tip-rate delta vs the location average). Returning null
   * leaves the Notes column blank.
   */
  classifyValue?: (
    value: number | null,
    snapshot: MetricSnapshot
  ) => ExpectationLabel | null;
  /**
   * Hide this row entirely if the predicate returns false. Used to suppress
   * tip metrics for periods with no POS data so the PDF doesn't render empty
   * "—" rows for locations that haven't ingested sales yet.
   */
  showIf?: (snapshot: MetricSnapshot) => boolean;
}

/** Neutral band for the tip-rate vs location-average classifier. */
const TIP_DELTA_NEUTRAL_PP = 0.25;

/** Neutral band (seconds) for the residual-vs-store-norm classifier. */
const KITCHEN_DELTA_NEUTRAL_SECONDS = 15;

/**
 * ADVISORY reading floor, not a gate (1.5.2 — reversing the 1.5.1 gate by
 * Tucker's 2026-07-29 decision). Day-to-day residual SD is ~114s, so the SE
 * on an employee's residual is ~114/sqrt(shifts): 1 shift ≈ ±114s,
 * 4 ≈ ±57s, 15 ≈ ±29s. The number renders at any n — below this floor the
 * automated Exceeds/Meets/Below badge is withheld and the footnote marks
 * the figures directional only; discounting a thin sample is the reader's
 * job, not the platform's.
 */
const KITCHEN_MIN_SHIFTS = 15;

const hasTipData = (s: MetricSnapshot) =>
  s.tip_rate_pct !== null || s.tip_per_hour !== null;

const hasKitchenData = (s: MetricSnapshot) =>
  s.kitchen_items !== null &&
  s.kitchen_items > 0 &&
  s.kitchen_avg_prep_seconds !== null &&
  s.kitchen_residual_seconds !== null;

// Order matches the existing on-page table.
const METRIC_DEFS: MetricDef[] = [
  { key: "on_time_pct", name: "On Time %", kind: "pct", classify: "on_time_pct" },
  { key: "attendance_pct", name: "Attendance %", kind: "pct", classify: "attendance_pct" },
  { key: "covered_shifts", name: "Covered Shifts", kind: "count" },
  { key: "survey_engagement_pct", name: "Survey Engagement %", kind: "pct", classify: "survey_engagement_pct" },
  { key: "customer_service_rating", name: "Customer Service Rating", kind: "rating", classify: "customer_service_rating" },
  { key: "customer_review_quantity", name: "Customer Review Quantity", kind: "count" },
  { key: "tattle_rating", name: "Tattle Rating", kind: "rating", classify: "tattle_rating" },
  { key: "tattle_quantity", name: "Tattle Quantity", kind: "count" },
  { key: "tattle_score_food_quality", name: "Tattle — Food Quality", kind: "rating", classify: "tattle_score_food_quality" },
  { key: "tattle_score_accuracy", name: "Tattle — Accuracy", kind: "rating", classify: "tattle_score_accuracy" },
  { key: "tattle_score_speed_of_service", name: "Tattle — Speed Of Service", kind: "rating", classify: "tattle_score_speed_of_service" },
  // ---- Phase 7b: tip metrics, suppressed when POS data is absent ----
  {
    key: "tip_rate_pct",
    name: "Tip Rate %",
    kind: "pct",
    showIf: hasTipData,
  },
  {
    key: "tip_per_hour",
    name: "Tip / Hour",
    kind: "money",
    showIf: hasTipData,
  },
  {
    key: "tip_rate_delta_pp",
    name: "Tip Rate vs Location Avg",
    kind: "delta_pp",
    showIf: hasTipData,
    classifyValue: (value) => {
      if (value === null) return null;
      if (value >  TIP_DELTA_NEUTRAL_PP) return "Exceeds Expectations";
      if (value < -TIP_DELTA_NEUTRAL_PP) return "Below Expectations";
      return "Meets Expectations";
    },
  },
  // ---- 1.5.1/1.5.2: Kitchen Speed block, rendered at any shift count ----
  // "Shifts you worked" framing: two people working identical shifts get
  // identical numbers — this reflects how the kitchen ran while they were
  // on, not their individual output. Reported metric only — deliberately
  // NOT a CS/TIS component. Leads with "vs norm", the only hour-fair
  // number; the raw average and the hour-matched store norm follow as
  // context, and the Tickets / Shifts row is how a reader judges whether
  // to trust the number. Scoring window is 10:00–19:59 local tickets only.
  {
    key: "kitchen_residual_seconds",
    name: "Kitchen — vs Store Norm, Same Hours",
    kind: "delta_duration",
    showIf: hasKitchenData,
    // Negative residual = the kitchen ran faster than the store's own
    // same-hour norm on their shifts = good. The number always renders;
    // the badge is withheld below the advisory floor — an automated
    // verdict on a 1–3 shift sample would pass exactly the judgment
    // humans are supposed to withhold (1.5.2).
    classifyValue: (value, s) => {
      if (value === null) return null;
      if (s.kitchen_shifts === null || s.kitchen_shifts < KITCHEN_MIN_SHIFTS) return null;
      if (value < -KITCHEN_DELTA_NEUTRAL_SECONDS) return "Exceeds Expectations";
      if (value > KITCHEN_DELTA_NEUTRAL_SECONDS) return "Below Expectations";
      return "Meets Expectations";
    },
  },
  {
    key: "kitchen_avg_prep_seconds",
    name: "Kitchen — Avg Fulfillment, Your Shifts",
    kind: "duration",
    showIf: hasKitchenData,
  },
  {
    key: "kitchen_baseline_prep_seconds",
    name: "Kitchen — Store Norm, Same Hours",
    kind: "duration",
    showIf: hasKitchenData,
  },
  {
    // Rendered as "tickets / shifts" via the special display below.
    key: "kitchen_tickets",
    name: "Kitchen — Tickets / Shifts",
    kind: "count",
    showIf: hasKitchenData,
  },
  // ---- Phase 9: composite customer service score, auto-hidden when null ----
  {
    key: "customer_service_score",
    name: "Customer Service Score",
    kind: "score_100",
    showIf: (s) => s.customer_service_score !== null,
    classifyValue: (value) => classifyCustomerServiceScore(value),
  },
];

// ---- Helpers ----

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isNaN(n) ? null : n;
}

function classifyOrNull(metric: FixedMetricKey, value: number | null) {
  return value === null ? null : classifyFixed(metric, value);
}

function priorValue(
  trailing: TrailingQuarter[] | undefined,
  key: keyof MetricSnapshot
): number | null {
  if (!trailing || trailing.length < 2) return null;
  return num(trailing[trailing.length - 2].metrics[key]);
}

/**
 * Δ vs prior quarter, formatted as ASCII for safe Helvetica rendering.
 *   "+2.30pp" / "-1.50pp"  for percentages
 *   "+0.18"   / "-0.22"    for ratings
 *   "+13"     / "-3"       for counts
 *   "0"                    for "no change"
 *   "—"                    when prior data is unavailable
 * Color encodes direction (green/red); we deliberately skip arrow glyphs
 * because @react-pdf's default Helvetica font has no glyph for ↑/↓ and
 * falls back to junk characters.
 */
function formatDelta(
  current: number | null,
  prior: number | null,
  kind: MetricKind
): { text: string; color: string } {
  if (current === null || prior === null) return { text: "—", color: COLORS.muted };
  const diff = current - prior;
  const eps = 0.001;
  if (Math.abs(diff) < eps) return { text: "0", color: COLORS.muted };
  const sign = diff > 0 ? "+" : "-"; // ASCII hyphen-minus, not the unicode minus
  // Prep times improve DOWNWARD — a shrinking duration is the green direction.
  const goodIsDown = kind === "duration" || kind === "delta_duration";
  const improved = goodIsDown ? diff < 0 : diff > 0;
  const color = improved ? COLORS.positive : COLORS.negative;
  const abs = Math.abs(diff);
  let body: string;
  if (kind === "pct" || kind === "delta_pp") body = `${abs.toFixed(2)}pp`;
  else if (kind === "rating") body = abs.toFixed(2);
  else if (kind === "money") body = `$${abs.toFixed(2)}`;
  else if (kind === "score_100") body = `${Math.round(abs)}`;
  else if (kind === "duration" || kind === "delta_duration") body = formatDuration(abs);
  else body = Math.round(abs).toString();
  return { text: `${sign}${body}`, color };
}

/** Seconds -> "6m 12s" (or "42s" under a minute). ASCII only for Helvetica. */
function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const s = Math.round(Math.abs(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
}

// ---- Metric row ----

interface MetricRowProps {
  name: string;
  display: string;
  classification: ExpectationLabel | null;
  delta: { text: string; color: string };
  isLast?: boolean;
}

function MetricRow({
  name,
  display,
  classification,
  delta,
  isLast,
}: MetricRowProps) {
  return (
    <View style={isLast ? styles.tableRowLast : styles.tableRow}>
      <Text style={styles.metricCol}>{name}</Text>
      <Text style={styles.valueCol}>{display}</Text>
      <Text style={[styles.deltaCol, { fontSize: 9, color: delta.color }]}>
        {delta.text}
      </Text>
      <View style={styles.notesCol}>
        {classification ? (
          <View style={[styles.badge, badgeStyle(classification)]}>
            <Text>{classification}</Text>
          </View>
        ) : (
          <Text style={{ color: COLORS.muted }}>—</Text>
        )}
      </View>
    </View>
  );
}

// ---- Customer Service breakdown sub-section (Phase 9) ----

function badgeForCsScore(score: number | null) {
  return classifyCustomerServiceScore(score);
}

function CustomerServiceBreakdown({
  metrics,
  weights,
}: {
  metrics: MetricSnapshot;
  weights: CustomerServiceWeights;
}) {
  const breakdown: CustomerServiceScoreBreakdown =
    computeCustomerServiceScoreBreakdown(
      metrics.tattle_rating,
      metrics.customer_service_rating,
      metrics.tip_rate_delta_pp,
      weights
    );

  const rows: Array<{
    name: string;
    native: string;
    score: number | null;
    effectiveWeight: number | null;
    configuredWeight: number;
  }> = [
    {
      name: "Tattle rating",
      native: formatRating(metrics.tattle_rating),
      score: breakdown.tattle_component_score,
      effectiveWeight: breakdown.effective_weight_tattle,
      configuredWeight: weights.weight_tattle,
    },
    {
      name: "Customer reviews",
      native: formatRating(metrics.customer_service_rating),
      score: breakdown.reviews_component_score,
      effectiveWeight: breakdown.effective_weight_reviews,
      configuredWeight: weights.weight_reviews,
    },
    {
      name: "Tip-rate delta",
      native:
        metrics.tip_rate_delta_pp === null
          ? "—"
          : `${metrics.tip_rate_delta_pp > 0 ? "+" : metrics.tip_rate_delta_pp < 0 ? "-" : ""}${Math.abs(
              metrics.tip_rate_delta_pp
            ).toFixed(2)}pp`,
      score: breakdown.tip_component_score,
      effectiveWeight: breakdown.effective_weight_tip,
      configuredWeight: weights.weight_tip,
    },
  ];

  return (
    <View>
      <Text style={styles.sectionTitle}>Customer Service breakdown</Text>
      <View style={styles.breakdownTable}>
        <View style={styles.breakdownHeader}>
          <Text style={[styles.tableHeaderCell, styles.bdComponentCol]}>
            Component
          </Text>
          <Text style={[styles.tableHeaderCell, styles.bdNativeCol]}>
            Native value
          </Text>
          <Text style={[styles.tableHeaderCell, styles.bdScoreCol]}>
            0–100 score
          </Text>
          <Text style={[styles.tableHeaderCell, styles.bdBadgeCol]}>
            Band (weight)
          </Text>
        </View>
        {rows.map((r, i) => {
          const isLast = i === rows.length - 1;
          const cls = badgeForCsScore(r.score);
          const weightStr =
            r.score === null
              ? `(${(r.configuredWeight * 100).toFixed(0)}% configured, missing)`
              : breakdown.composite_score !== null && r.effectiveWeight !== null
                ? `(weight ${(r.effectiveWeight * 100).toFixed(0)}%)`
                : `(weight ${(r.configuredWeight * 100).toFixed(0)}%)`;
          return (
            <View
              key={r.name}
              style={isLast ? styles.breakdownRowLast : styles.breakdownRow}
            >
              <Text style={styles.bdComponentCol}>{r.name}</Text>
              <Text style={styles.bdNativeCol}>{r.native}</Text>
              <Text style={styles.bdScoreCol}>
                {r.score === null ? "—" : formatCustomerServiceScore(r.score)}
              </Text>
              <View style={styles.bdBadgeCol}>
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  {cls ? (
                    <View style={[styles.badge, badgeStyle(cls)]}>
                      <Text>
                        {cls === "Exceeds Expectations"
                          ? "Green"
                          : cls === "Meets Expectations"
                            ? "Yellow"
                            : "Red"}
                      </Text>
                    </View>
                  ) : (
                    <Text style={{ color: COLORS.muted }}>—</Text>
                  )}
                  <Text style={{ marginLeft: 6, color: COLORS.muted, fontSize: 9 }}>
                    {weightStr}
                  </Text>
                </View>
              </View>
            </View>
          );
        })}
      </View>
      {breakdown.components_count === 2 && (
        <Text style={{ marginTop: 6, fontSize: 9, color: COLORS.muted }}>
          Composite computed from 2 of 3 components (the missing component&apos;s
          weight was redistributed pro-rata across the two present components).
        </Text>
      )}
      <Text style={styles.legendBox}>
        Customer Service Score blends three signals into a single 0–100
        composite. Each component is normalized linearly (ratings:
        (rating − 1) / 4 × 100; tip-rate delta: (delta + 2) / 4 × 100, clamped
        to 0–100). Bands: Green ≥ 85, Yellow 70–&lt;85, Red &lt; 70.{"\n"}
        Note: the tip component on this score uses a ±2pp window centered on
        the location average, which is intentionally different from the
        dashboard&apos;s Tip Rate vs Location Avg badge (±0.25pp neutral band).
        Same underlying signal; the badge measures &quot;vs location avg,&quot;
        the score measures &quot;contribution to top-tier service.&quot;
      </Text>
    </View>
  );
}

// ---- Document ----

export function EmployeeReportDocument({ data }: { data: ReportData }) {
  const m = data.metrics;
  // Tenure is measured as-of the report's generation time.
  const tenureAsOf = data.generated_at
    ? data.generated_at.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const tenure = data.hire_date ? formatTenure(data.hire_date, tenureAsOf) : "—";
  const hire = data.hire_date ? formatHireDate(data.hire_date) : "—";

  const trailing = data.trailing_quarters;

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.h1}>Employee Performance Report</Text>
        <Text style={styles.subtitle}>
          Generated {new Date(data.generated_at).toLocaleString()}
        </Text>

        <View style={styles.headerGrid}>
          <View style={styles.headerCell}>
            <Text style={styles.label}>Employee</Text>
            <Text style={styles.value}>{data.employee_name}</Text>
          </View>
          <View style={styles.headerCell}>
            <Text style={styles.label}>Employee ID</Text>
            <Text style={styles.value}>{data.employee_code}</Text>
          </View>
          <View style={styles.headerCell}>
            <Text style={styles.label}>Location</Text>
            <Text style={styles.value}>{data.location_name}</Text>
          </View>
          <View style={styles.headerCell}>
            <Text style={styles.label}>Report Period</Text>
            <Text style={styles.value}>{data.report_period_label}</Text>
          </View>
          <View style={styles.headerCell}>
            <Text style={styles.label}>Hire Date</Text>
            <Text style={styles.value}>{hire}</Text>
          </View>
          <View style={styles.headerCell}>
            <Text style={styles.label}>Tenure</Text>
            <Text style={styles.value}>{tenure}</Text>
          </View>
        </View>

        <View style={styles.hr} />

        <Text style={styles.sectionTitle}>Performance Metrics</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHeaderCell, styles.metricCol]}>Metric</Text>
            <Text style={[styles.tableHeaderCell, styles.valueCol]}>Value</Text>
            <Text style={[styles.tableHeaderCell, styles.deltaCol]}>Δ vs prior</Text>
            <Text style={[styles.tableHeaderCell, styles.notesCol]}>Notes</Text>
          </View>

          {(() => {
            const visible = METRIC_DEFS.filter(
              (def) => !def.showIf || def.showIf(m)
            );
            return visible.map((def, i) => {
              const current = num(m[def.key]);
              const prior = priorValue(trailing, def.key);
              const delta = formatDelta(current, prior, def.kind);
              // Special display for survey engagement (combines pct + counts)
              let display: string;
              if (def.key === "survey_engagement_pct") {
                display =
                  m.survey_engagement_pct !== null
                    ? `${formatPercent(m.survey_engagement_pct)}  (${formatQuantity(m.surveys_completed)} of ${formatQuantity(m.surveys_assigned)})`
                    : "—";
              } else if (def.key === "kitchen_tickets") {
                // 1.5.1: combined sample-size row, e.g. "1,847 / 42".
                display = `${formatQuantity(m.kitchen_tickets)} / ${formatQuantity(m.kitchen_shifts)}`;
              } else if (def.kind === "pct") {
                display = formatPercent(current);
              } else if (def.kind === "rating") {
                display = formatRating(current);
              } else if (def.kind === "money") {
                display = formatMoney(current);
              } else if (def.kind === "delta_pp") {
                // ASCII +/- only — Helvetica has no unicode-minus glyph.
                display =
                  current === null
                    ? "—"
                    : `${current > 0 ? "+" : current < 0 ? "-" : ""}${Math.abs(
                        current
                      ).toFixed(2)}pp`;
              } else if (def.kind === "score_100") {
                // Composite score rounds to whole numbers per the Phase 9 spec.
                display =
                  current === null ? "—" : `${formatCustomerServiceScore(current)} / 100`;
              } else if (def.kind === "duration") {
                display = formatDuration(current);
              } else if (def.kind === "delta_duration") {
                // Negative = faster than the store average. ASCII +/- only.
                display =
                  current === null
                    ? "—"
                    : current === 0
                      ? "0s"
                      : `${current < 0 ? "-" : "+"}${formatDuration(current)} (${current < 0 ? "faster" : "slower"})`;
              } else {
                display = formatQuantity(current);
              }
              let classification: ExpectationLabel | null = null;
              if (def.classifyValue) {
                classification = def.classifyValue(current, m);
              } else if (def.classify) {
                classification = classifyOrNull(def.classify, current);
              }
              return (
                <MetricRow
                  key={def.key}
                  name={def.name}
                  display={display}
                  classification={classification}
                  delta={delta}
                  isLast={i === visible.length - 1}
                />
              );
            });
          })()}
        </View>

        {hasKitchenData(m) && (
          <Text style={[styles.currencyLine, { marginTop: 4 }]}>
            Kitchen Speed reflects how the kitchen ran during shifts this
            employee worked (tickets fired 10am–8pm, vs this store&apos;s own
            same-hour norm for the period) — a shared shift outcome, not a
            measure of individual output.
            {m.kitchen_shifts !== null && m.kitchen_shifts < KITCHEN_MIN_SHIFTS
              ? " Figures based on fewer than 15 shifts are directional only."
              : ""}
          </Text>
        )}

        {m.customer_service_score !== null && (
          <CustomerServiceBreakdown
            metrics={m}
            weights={data.customer_service_weights ?? DEFAULT_CS_WEIGHTS}
          />
        )}

        {data.category_currency && data.category_currency.length > 0 && (() => {
          const stale = staleCategories(data.category_currency, data.report_period_end);
          const staleKeys = new Set(stale.map((s) => s.key));
          return (
            <View style={styles.currencyBlock}>
              {stale.length > 0 && (
                <Text style={styles.currencyBanner}>
                  Partial data: {stale
                    .map((s) => `${s.label} through ${s.data_through}`)
                    .join(", ")} — scores may not reflect the full period.
                </Text>
              )}
              <Text style={styles.currencyLine}>
                Data through:{" "}
                {data.category_currency
                  .map(
                    (c) =>
                      `${c.label} ${c.data_through ?? "—"}${staleKeys.has(c.key) ? " (!)" : ""}`
                  )
                  .join("  ·  ")}
              </Text>
            </View>
          );
        })()}

        <Text style={styles.sectionTitle}>Manager Feedback</Text>
        <View style={styles.feedbackBox}>
          <Text>
            {data.manager_feedback?.trim()
              ? data.manager_feedback
              : "No feedback recorded for this period."}
          </Text>
        </View>

        <Text style={styles.sectionTitle}>Signatures</Text>
        <View style={styles.signatureRow}>
          <View style={styles.sigSignatureCol}>
            <View style={styles.sigLine} />
            <Text style={styles.sigLabel}>Employee Signature</Text>
          </View>
          <View style={styles.sigDateCol}>
            <View style={styles.sigLine} />
            <Text style={styles.sigLabel}>Date</Text>
          </View>
        </View>
        <View style={styles.signatureRow}>
          <View style={styles.sigSignatureCol}>
            <View style={styles.sigLine} />
            <Text style={styles.sigLabel}>Manager Signature</Text>
          </View>
          <View style={styles.sigDateCol} />
        </View>

        <Text style={styles.footer} fixed>
          {data.employee_name} · {data.report_period_label} · Template v{TEMPLATE_VERSION}
        </Text>
      </Page>
    </Document>
  );
}
