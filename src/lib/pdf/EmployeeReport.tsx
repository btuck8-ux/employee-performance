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
  formatHireDate,
  formatPercent,
  formatQuantity,
  formatRating,
  formatTenure,
} from "@/lib/format";
import type { ExpectationLabel, FixedMetricKey } from "@/lib/types";

// 1.1.0 added Δ + sparkline + trend page. 1.2.0 keeps Δ but drops the
// sparkline/trend page (Helvetica's glyph set doesn't include the arrow
// characters and the bar-chart density wasn't carrying its weight on the
// page) and switches Δ formatting to ASCII +/- only — color carries the
// direction signal cleanly without needing arrow glyphs.
export const TEMPLATE_VERSION = "1.2.0";

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
}

// ---- Metric kind table ----

type MetricKind = "pct" | "rating" | "count";

interface MetricDef {
  key: keyof MetricSnapshot;
  name: string;
  kind: MetricKind;
  classify?: FixedMetricKey;
}

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
  const color = diff > 0 ? COLORS.positive : COLORS.negative;
  const abs = Math.abs(diff);
  let body: string;
  if (kind === "pct") body = `${abs.toFixed(2)}pp`;
  else if (kind === "rating") body = abs.toFixed(2);
  else body = Math.round(abs).toString();
  return { text: `${sign}${body}`, color };
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

          {METRIC_DEFS.map((def, i) => {
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
            } else if (def.kind === "pct") {
              display = formatPercent(current);
            } else if (def.kind === "rating") {
              display = formatRating(current);
            } else {
              display = formatQuantity(current);
            }
            return (
              <MetricRow
                key={def.key}
                name={def.name}
                display={display}
                classification={
                  def.classify ? classifyOrNull(def.classify, current) : null
                }
                delta={delta}
                isLast={i === METRIC_DEFS.length - 1}
              />
            );
          })}
        </View>

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
