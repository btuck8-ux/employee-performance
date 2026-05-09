/* eslint-disable jsx-a11y/alt-text */
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import {
  formatHireDate,
  formatPercent,
  formatQuantity,
  formatTenure,
} from "@/lib/format";

export const TASK_DETAIL_TEMPLATE_VERSION = "1.0.0";

const COLORS = {
  text: "#000000",
  rule: "#E2E8F0",
  muted: "#64748B",
  surface: "#F8FAFC",
  highlightBg: "#FFF2CC",
  alertBg: "#F4CCCC",
};

const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 10, fontFamily: "Helvetica", color: COLORS.text },
  h1: { fontSize: 20, fontWeight: 700, marginBottom: 4 },
  subtitle: { fontSize: 10, color: COLORS.muted, marginBottom: 14 },
  hr: { borderBottomWidth: 1, borderBottomColor: COLORS.rule, marginVertical: 10 },
  headerGrid: { flexDirection: "row", flexWrap: "wrap", marginBottom: 6 },
  headerCell: { width: "33%", marginBottom: 5 },
  label: { fontSize: 8, color: COLORS.muted, marginBottom: 1 },
  value: { fontSize: 11 },
  sectionTitle: { fontSize: 12, fontWeight: 700, marginTop: 14, marginBottom: 6 },
  // Summary tiles row
  tilesRow: { flexDirection: "row", gap: 8, marginBottom: 4 },
  tile: {
    flex: 1,
    borderWidth: 1,
    borderColor: COLORS.rule,
    borderRadius: 4,
    padding: 8,
    backgroundColor: COLORS.surface,
  },
  tileLabel: { fontSize: 8, color: COLORS.muted },
  tileValue: { fontSize: 18, fontWeight: 700, marginTop: 2 },
  tileSub: { fontSize: 8, color: COLORS.muted, marginTop: 2 },
  // Tables
  table: { borderWidth: 1, borderColor: COLORS.rule, borderRadius: 4 },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#F1F5F9",
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.rule,
  },
  th: { fontSize: 8, fontWeight: 700, color: COLORS.muted },
  tr: {
    flexDirection: "row",
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.rule,
  },
  trLast: { flexDirection: "row", paddingVertical: 4, paddingHorizontal: 6 },
  // Column widths for per-task table
  taskListCol: { flex: 3 },
  taskNameCol: { flex: 4 },
  acctCol: { flex: 1.2 },
  doneCol: { flex: 1.2 },
  pctCol: { flex: 1.5 },
  // Column widths for snapshot tables
  dateCol: { flex: 2 },
  // Highlight low completion %
  lowPct: { backgroundColor: COLORS.alertBg },
  footer: {
    position: "absolute",
    bottom: 16,
    left: 32,
    right: 32,
    fontSize: 7,
    color: COLORS.muted,
    textAlign: "center",
  },
});

export interface TaskDetailReportData {
  employee_name: string;
  employee_code: string;
  location_name: string;
  hire_date: string | null;
  report_period_label: string;
  report_period_start: string;
  report_period_end: string;
  generated_at: string;
  summary: {
    tasks_accountable: number;
    tasks_completed: number;
    tasks_owned: number;
    task_completion_pct: number | null;
    task_list_completion_pct: number | null;
    avg_task_list_completion_pct: number | null;
    list_instances_accountable: number;
    list_instances_full: number;
  };
  per_task: Array<{
    list_name: string;
    task_name: string;
    accountable: number;
    completed: number;
    owned: number;
    completion_pct: number | null;
  }>;
  daily: Array<{
    date: string;
    accountable: number;
    completed: number;
    completion_pct: number | null;
  }>;
  weekly: Array<{
    week_start: string;
    accountable: number;
    completed: number;
    completion_pct: number | null;
  }>;
  per_list: Array<{
    list_name: string;
    instances_accountable: number;
    instances_full: number;
    full_rate_pct: number | null;
    avg_completion_pct: number | null;
  }>;
}

function num(v: number | null | undefined) {
  return v === null || v === undefined ? "—" : formatPercent(v);
}

export function EmployeeTaskDetailReportDocument({
  data,
}: {
  data: TaskDetailReportData;
}) {
  // Tenure is measured as-of the report's generation time (i.e. "as of now"),
  // not as-of the period end. A reader looking at a fresh report intuitively
  // expects current tenure. Pass generated_at as a string so formatTenure's
  // parseDateLocal handles it (avoids UTC-parsing day shift).
  const tenureAsOf = data.generated_at ? data.generated_at.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const tenure = data.hire_date ? formatTenure(data.hire_date, tenureAsOf) : "—";
  const hire = data.hire_date ? formatHireDate(data.hire_date) : "—";

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.h1}>Task Detail Report</Text>
        <Text style={styles.subtitle}>
          {data.employee_name} · {data.report_period_label} · Generated{" "}
          {new Date(data.generated_at).toLocaleString()}
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
            <Text style={styles.label}>Hire Date</Text>
            <Text style={styles.value}>{hire}</Text>
          </View>
          <View style={styles.headerCell}>
            <Text style={styles.label}>Tenure</Text>
            <Text style={styles.value}>{tenure}</Text>
          </View>
          <View style={styles.headerCell}>
            <Text style={styles.label}>Period</Text>
            <Text style={styles.value}>{data.report_period_label}</Text>
          </View>
        </View>

        <View style={styles.hr} />

        <Text style={styles.sectionTitle}>Summary</Text>
        <View style={styles.tilesRow}>
          <View style={styles.tile}>
            <Text style={styles.tileLabel}>Task Completion %</Text>
            <Text style={styles.tileValue}>{num(data.summary.task_completion_pct)}</Text>
            <Text style={styles.tileSub}>
              {formatQuantity(data.summary.tasks_completed)} / {formatQuantity(data.summary.tasks_accountable)} tasks
            </Text>
          </View>
          <View style={styles.tile}>
            <Text style={styles.tileLabel}>Task List Completion %</Text>
            <Text style={styles.tileValue}>{num(data.summary.task_list_completion_pct)}</Text>
            <Text style={styles.tileSub}>
              {formatQuantity(data.summary.list_instances_full)} / {formatQuantity(data.summary.list_instances_accountable)} lists at 100%
            </Text>
          </View>
          <View style={styles.tile}>
            <Text style={styles.tileLabel}>Avg Task-List Rate</Text>
            <Text style={styles.tileValue}>{num(data.summary.avg_task_list_completion_pct)}</Text>
            <Text style={styles.tileSub}>across accountable lists</Text>
          </View>
          <View style={styles.tile}>
            <Text style={styles.tileLabel}>Tasks Owned</Text>
            <Text style={styles.tileValue}>{formatQuantity(data.summary.tasks_owned)}</Text>
            <Text style={styles.tileSub}>personally completed</Text>
          </View>
        </View>

        <Text style={styles.sectionTitle}>Per-Task Breakdown (worst-to-best)</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, styles.taskListCol]}>List</Text>
            <Text style={[styles.th, styles.taskNameCol]}>Task</Text>
            <Text style={[styles.th, styles.acctCol]}>Accountable</Text>
            <Text style={[styles.th, styles.doneCol]}>Completed</Text>
            <Text style={[styles.th, styles.doneCol]}>Owned</Text>
            <Text style={[styles.th, styles.pctCol]}>Compl. %</Text>
          </View>
          {data.per_task.length === 0 ? (
            <View style={styles.trLast}>
              <Text style={[{ flex: 1 }, { color: COLORS.muted }]}>No accountable tasks in this period.</Text>
            </View>
          ) : (
            data.per_task.slice(0, 40).map((t, i) => {
              const isLow = t.completion_pct !== null && t.completion_pct < 80;
              const isLast = i === Math.min(39, data.per_task.length - 1);
              return (
                <View
                  key={`${t.list_name}|${t.task_name}|${i}`}
                  style={[isLast ? styles.trLast : styles.tr, isLow ? styles.lowPct : {}]}
                >
                  <Text style={styles.taskListCol}>{t.list_name}</Text>
                  <Text style={styles.taskNameCol}>{t.task_name}</Text>
                  <Text style={styles.acctCol}>{formatQuantity(t.accountable)}</Text>
                  <Text style={styles.doneCol}>{formatQuantity(t.completed)}</Text>
                  <Text style={styles.doneCol}>{formatQuantity(t.owned)}</Text>
                  <Text style={styles.pctCol}>{num(t.completion_pct)}</Text>
                </View>
              );
            })
          )}
        </View>
        {data.per_task.length > 40 && (
          <Text style={[styles.tileSub, { marginTop: 4 }]}>
            Showing 40 worst tasks of {data.per_task.length}.
          </Text>
        )}

        <Text style={styles.sectionTitle} break>
          Daily Snapshot
        </Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, styles.dateCol]}>Date</Text>
            <Text style={[styles.th, styles.acctCol]}>Accountable</Text>
            <Text style={[styles.th, styles.doneCol]}>Completed</Text>
            <Text style={[styles.th, styles.pctCol]}>Compl. %</Text>
          </View>
          {data.daily.length === 0 ? (
            <View style={styles.trLast}>
              <Text style={[{ flex: 1 }, { color: COLORS.muted }]}>No data.</Text>
            </View>
          ) : (
            data.daily.map((d, i) => {
              const isLow = d.completion_pct !== null && d.completion_pct < 80;
              const isLast = i === data.daily.length - 1;
              return (
                <View
                  key={d.date}
                  style={[isLast ? styles.trLast : styles.tr, isLow ? styles.lowPct : {}]}
                >
                  <Text style={styles.dateCol}>{d.date}</Text>
                  <Text style={styles.acctCol}>{formatQuantity(d.accountable)}</Text>
                  <Text style={styles.doneCol}>{formatQuantity(d.completed)}</Text>
                  <Text style={styles.pctCol}>{num(d.completion_pct)}</Text>
                </View>
              );
            })
          )}
        </View>

        <Text style={styles.sectionTitle}>Weekly Snapshot</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, styles.dateCol]}>Week of</Text>
            <Text style={[styles.th, styles.acctCol]}>Accountable</Text>
            <Text style={[styles.th, styles.doneCol]}>Completed</Text>
            <Text style={[styles.th, styles.pctCol]}>Compl. %</Text>
          </View>
          {data.weekly.length === 0 ? (
            <View style={styles.trLast}>
              <Text style={[{ flex: 1 }, { color: COLORS.muted }]}>No data.</Text>
            </View>
          ) : (
            data.weekly.map((w, i) => {
              const isLow = w.completion_pct !== null && w.completion_pct < 80;
              const isLast = i === data.weekly.length - 1;
              return (
                <View
                  key={w.week_start}
                  style={[isLast ? styles.trLast : styles.tr, isLow ? styles.lowPct : {}]}
                >
                  <Text style={styles.dateCol}>{w.week_start}</Text>
                  <Text style={styles.acctCol}>{formatQuantity(w.accountable)}</Text>
                  <Text style={styles.doneCol}>{formatQuantity(w.completed)}</Text>
                  <Text style={styles.pctCol}>{num(w.completion_pct)}</Text>
                </View>
              );
            })
          )}
        </View>

        <Text style={styles.sectionTitle} break>
          Per-List Breakdown
        </Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, styles.taskListCol]}>List</Text>
            <Text style={[styles.th, styles.acctCol]}>Instances</Text>
            <Text style={[styles.th, styles.doneCol]}>At 100%</Text>
            <Text style={[styles.th, styles.pctCol]}>100% rate</Text>
            <Text style={[styles.th, styles.pctCol]}>Avg rate</Text>
          </View>
          {data.per_list.length === 0 ? (
            <View style={styles.trLast}>
              <Text style={[{ flex: 1 }, { color: COLORS.muted }]}>No accountable lists.</Text>
            </View>
          ) : (
            data.per_list.map((l, i) => {
              const isLast = i === data.per_list.length - 1;
              return (
                <View key={l.list_name} style={isLast ? styles.trLast : styles.tr}>
                  <Text style={styles.taskListCol}>{l.list_name}</Text>
                  <Text style={styles.acctCol}>{formatQuantity(l.instances_accountable)}</Text>
                  <Text style={styles.doneCol}>{formatQuantity(l.instances_full)}</Text>
                  <Text style={styles.pctCol}>{num(l.full_rate_pct)}</Text>
                  <Text style={styles.pctCol}>{num(l.avg_completion_pct)}</Text>
                </View>
              );
            })
          )}
        </View>

        <Text style={styles.footer} fixed>
          {data.employee_name} · Task Detail · {data.report_period_label} · Template v{TASK_DETAIL_TEMPLATE_VERSION}
        </Text>
      </Page>
    </Document>
  );
}
