/**
 * §4-H5 reconciliation arithmetic — PURE (no I/O) so the fixture tests pin
 * it. Compares EPD's two schedule sources at (employee, store-local date)
 * granularity, the finest grain both sides share: time_entries collapses to
 * one row per employee-day, so per-shift comparison is only possible on the
 * direct side.
 *
 * The headline number (2026-08-23 addendum §4, and what CP asked for):
 * CP-sourced scheduled days whose shifts 7shifts no longer returns —
 * `cp_day_vanished_upstream` (direct rows all tombstoned) plus
 * `cp_only_days` (no direct row at all: vanished before the direct feed's
 * first pull, or a CP-feed artifact). Broken down per store and per week.
 */

export interface DirectShiftRow {
  seven_shifts_shift_id: number;
  location_id: string;
  employee_id: string | null;
  entry_date: string;
  /** 7shifts returns store-local ISO with offset — chars 11–19 are the
   * local wall-clock time (probe-verified format). */
  start_at: string;
  missing_upstream_since: string | null;
  attendance_status: string | null;
}

export interface CpSourcedDay {
  employee_id: string;
  location_id: string;
  entry_date: string;
  entry_type: "scheduled" | "worked";
  in_time: string | null;
}

export interface ReconcileReport {
  totals: {
    cp_scheduled_days: number;
    direct_live_days: number;
    in_both: number;
    /** CP counts it; every matching direct shift is tombstoned upstream. */
    cp_day_vanished_upstream: number;
    /** CP counts it; the direct feed has no row at all. */
    cp_only_days: number;
    /** Live upstream shift with no CP-sourced scheduled row. */
    direct_only_days: number;
    /** in_both days where the two sides' start times differ > 15 minutes. */
    start_time_mismatches: number;
    /** Direct rows that resolve to no EPD employee (excluded from day math). */
    direct_unmatched_rows: number;
  };
  /** store -> { vanished_or_cp_only, cp_scheduled_days } */
  by_store: Record<string, { vanished_or_cp_only: number; cp_scheduled_days: number }>;
  /** week-monday -> vanished_or_cp_only count */
  by_week: Record<string, number>;
  /** attendance_status of live upstream shifts on CP-scheduled UNWORKED days. */
  unworked_day_status: Record<string, number>;
}

const MISMATCH_MINUTES = 15;

function weekMonday(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function minutesOf(t: string | null): number | null {
  if (!t) return null;
  const m = t.match(/^(\d{2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

interface DayAgg {
  live: DirectShiftRow[];
  tombstoned: DirectShiftRow[];
}

export function reconcileScheduleSets(
  direct: DirectShiftRow[],
  cpSourced: CpSourcedDay[],
  codeByLocationId: Map<string, string>
): ReconcileReport {
  const key = (employeeId: string, date: string) => `${employeeId}|${date}`;

  let directUnmatched = 0;
  const directByDay = new Map<string, DayAgg>();
  for (const r of direct) {
    if (r.employee_id === null) {
      directUnmatched += 1;
      continue;
    }
    const k = key(r.employee_id, r.entry_date);
    let agg = directByDay.get(k);
    if (!agg) {
      agg = { live: [], tombstoned: [] };
      directByDay.set(k, agg);
    }
    (r.missing_upstream_since === null ? agg.live : agg.tombstoned).push(r);
  }

  const cpScheduled = new Map<string, CpSourcedDay>();
  const worked = new Set<string>();
  for (const r of cpSourced) {
    const k = key(r.employee_id, r.entry_date);
    if (r.entry_type === "worked") worked.add(k);
    else cpScheduled.set(k, r);
  }

  const byStore: ReconcileReport["by_store"] = {};
  const byWeek: ReconcileReport["by_week"] = {};
  const unworkedStatus: Record<string, number> = {};
  const bump = (
    store: string,
    field: "vanished_or_cp_only" | "cp_scheduled_days"
  ) => {
    byStore[store] = byStore[store] ?? {
      vanished_or_cp_only: 0,
      cp_scheduled_days: 0,
    };
    byStore[store][field] += 1;
  };

  let inBoth = 0;
  let vanished = 0;
  let cpOnly = 0;
  let mismatches = 0;

  for (const [k, cpRow] of cpScheduled) {
    const store = codeByLocationId.get(cpRow.location_id) ?? "UNMAPPED";
    bump(store, "cp_scheduled_days");
    const agg = directByDay.get(k);
    if (agg && agg.live.length > 0) {
      inBoth += 1;
      const cpMin = minutesOf(cpRow.in_time);
      const directMin = Math.min(
        ...agg.live
          .map((r) => minutesOf(r.start_at.slice(11, 19)))
          .filter((v): v is number => v !== null)
      );
      if (
        cpMin !== null &&
        Number.isFinite(directMin) &&
        Math.abs(cpMin - directMin) > MISMATCH_MINUTES
      ) {
        mismatches += 1;
      }
      if (!worked.has(k)) {
        for (const r of agg.live) {
          const status = r.attendance_status ?? "unknown";
          unworkedStatus[status] = (unworkedStatus[status] ?? 0) + 1;
        }
      }
    } else {
      if (agg && agg.tombstoned.length > 0) vanished += 1;
      else cpOnly += 1;
      bump(store, "vanished_or_cp_only");
      const week = weekMonday(cpRow.entry_date);
      byWeek[week] = (byWeek[week] ?? 0) + 1;
    }
  }

  let directOnly = 0;
  let directLiveDays = 0;
  for (const [k, agg] of directByDay) {
    if (agg.live.length === 0) continue;
    directLiveDays += 1;
    if (!cpScheduled.has(k)) directOnly += 1;
  }

  return {
    totals: {
      cp_scheduled_days: cpScheduled.size,
      direct_live_days: directLiveDays,
      in_both: inBoth,
      cp_day_vanished_upstream: vanished,
      cp_only_days: cpOnly,
      direct_only_days: directOnly,
      start_time_mismatches: mismatches,
      direct_unmatched_rows: directUnmatched,
    },
    by_store: byStore,
    by_week: byWeek,
    unworked_day_status: unworkedStatus,
  };
}
