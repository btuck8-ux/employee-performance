import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  computeMetricsForRange,
  frozenQuarterRefusal,
} from "@/lib/performance-recompute";
import {
  runRecomputeJobs,
  type RecomputeJob,
} from "@/lib/ingest/sevenshifts/recompute";
import { quarterInfo, type Quarter } from "@/lib/quarter";

/**
 * Scoped recompute lever (recompute-lever spec 2026-08-25, Build 1).
 *
 * WHY: performance_records still holds pre-flip numbers (last written by
 * the Houston sales backfill's recompute tail 85 minutes before the flip
 * deploy). The live-compute surfaces are already correct; the persisted
 * surfaces (PDFs, bulk reports, rankings quarter list, teams scatter,
 * report builder, tattle summaries) are stale. The nightly would self-heal
 * them BLIND — no report, no verification, no record of what moved. After
 * a sprint whose entire lesson is that unobserved correctness is
 * indistinguishable from unobserved error, staleness gets closed with a
 * report, or not at all.
 *
 * THE REPORT IS THE DELIVERABLE, NOT THE WRITE. Both modes emit per
 * employee: before/after attendance, on-time, hours, tip rate, deltas,
 * scheduled/worked days; plus the summary (touched, >10-point attendance
 * movers, every metric that became null WITH its reason, day-weighted
 * store attendance before/after). dry_run computes "after" via
 * computeMetricsForRange — pure compute, persists nothing — which is what
 * makes the COS checkpoint (Nathan Johnson 100.0%, Tavian Jones 72.2%,
 * Nick Goins null) a checkpoint rather than a leap.
 *
 * The write path reuses runRecomputeJobs VERBATIM — same weights fetch,
 * same worker pool, same idempotent write as every CSV importer and the
 * sales recompute tail. This lever is scope plus a report, nothing more.
 *
 * GUARDS (the gap-filler's discipline):
 *  - dry_run is the DEFAULT; a missing write param means report only.
 *  - write=1 requires confirm_quarters echoing the exact quarter (Q3-2026).
 *  - FROZEN QUARTERS (report_periods.frozen, mig 063): the guard lives in
 *    recomputePerformanceForQuarter — the asset, not this caller (frozen-
 *    quarter spec 2026-08-25 §1; the lever's old hardcoded year check was
 *    deleted — the FLAG is the one definition). §3b door-stop: write=1 on
 *    a frozen quarter without override_frozen_quarter naming it exactly is
 *    refused 400 BEFORE any work, via the same frozenQuarterRefusal
 *    decision the asset uses — never a 200 whose recompute_failures is the
 *    only tell. The override threads through as allowFrozenQuarter; the
 *    asset guard remains the backstop for the other nineteen write paths.
 *    Dry-run on a frozen quarter is allowed by design (writes nothing; the
 *    byte-identical verification tool). Q3/Q4 2025 are frozen by agreement
 *    with Training HQ, and recomputing one must be a deliberate, named act.
 *  - one location per invocation, like backfill-worked-time.
 *
 * AUTH: Bearer <CRON_SECRET>.
 *   GET /api/admin/recompute-quarter
 *     ?location=COS            location_code, one per invocation — required
 *     &year=2026&quarter=3     both explicit — never defaulted to "current"
 *     &write=1                 optional; default is the dry-run report
 *     &confirm_quarters=Q3-2026            required when write=1
 *     &override_frozen_quarter=Q4-2025     required to write a frozen quarter
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const COMPUTE_CONCURRENCY = 6;

interface EmployeeReport {
  employee_id: string;
  employee_name: string;
  employee_code: string;
  before: {
    attendance_pct: number | null;
    on_time_pct: number | null;
    hours_worked: number | null;
    tip_rate_pct: number | null;
  };
  after: {
    attendance_pct: number | null;
    on_time_pct: number | null;
    hours_worked: number | null;
    tip_rate_pct: number | null;
  };
  delta_attendance_pp: number | null;
  scheduled_days: number;
  attended_days: number;
  worked_days: number;
  null_reason: string | null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
};
const round1 = (n: number | null): number | null =>
  n === null ? null : Math.round(n * 10) / 10;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const locationCode = url.searchParams.get("location");
  const year = Number(url.searchParams.get("year"));
  const quarterNum = Number(url.searchParams.get("quarter"));
  const write = url.searchParams.get("write") === "1";

  if (
    !locationCode ||
    !Number.isInteger(year) ||
    ![1, 2, 3, 4].includes(quarterNum)
  ) {
    return NextResponse.json(
      { error: "location, year and quarter (1-4) are required — never defaulted" },
      { status: 400 }
    );
  }
  const quarter = quarterNum as Quarter;
  const quarterLabel = `Q${quarter}-${year}`;

  // Frozen-quarter handling moved INTO recomputePerformanceForQuarter (mig
  // 063 + frozen-quarter spec §1b) — the override just threads through.
  const overrideFrozenQuarter =
    url.searchParams.get("override_frozen_quarter") ?? undefined;
  if (write) {
    const confirmed = url.searchParams.get("confirm_quarters");
    if (confirmed !== quarterLabel) {
      return NextResponse.json(
        {
          error: `write mode requires confirm_quarters naming the exact quarter: expected "${quarterLabel}"`,
        },
        { status: 400 }
      );
    }
  }

  const supabase = createAdminClient();

  // §3b DOOR-STOP (frozen-quarter spec addendum 2026-08-25): a write=1 aimed
  // at a frozen quarter without the exact override refuses 400 HERE, before
  // any work — otherwise the asset guard's per-job refusals come back as
  // HTTP 200 with recompute_failures populated, and an operator checking
  // status codes sees success on a write that wrote nothing (the
  // silent-partial shape both projects ranked worse than an outage). This is
  // NOT a second definition of frozen: it reads report_periods.frozen (mig
  // 063) through the SAME frozenQuarterRefusal decision the asset uses; the
  // asset guard stays the backstop for the other nineteen write paths.
  // Dry-run deliberately skips this — it writes nothing, and dry-running a
  // frozen quarter is exactly how the byte-identical recompute verification
  // was done this morning.
  if (write) {
    const { data: periodRow, error: frozenErr } = await supabase
      .from("report_periods")
      .select("frozen")
      .eq("year", year)
      .eq("quarter", quarter)
      .maybeSingle();
    if (frozenErr) {
      return NextResponse.json(
        { error: `report_periods read: ${frozenErr.message}` },
        { status: 500 }
      );
    }
    const refusal = frozenQuarterRefusal(
      periodRow?.frozen === true,
      year,
      quarter,
      overrideFrozenQuarter
    );
    if (refusal) {
      // Same decision, operator-layer wording: the curl caller passes the
      // URL param, not the internal option name.
      return NextResponse.json(
        {
          error: `${quarterLabel} is frozen (THQ arrangement) — a write requires override_frozen_quarter="${quarterLabel}", named exactly`,
        },
        { status: 400 }
      );
    }
  }

  const { data: loc, error: locError } = await supabase
    .from("locations")
    .select("id, location_code")
    .eq("location_code", locationCode)
    .maybeSingle();
  if (locError) return NextResponse.json({ error: locError.message }, { status: 500 });
  if (!loc) {
    return NextResponse.json(
      { error: `no location with code "${locationCode}"` },
      { status: 400 }
    );
  }
  const locationId = String(loc.id);

  const q = quarterInfo(year, quarter);
  const periodStart = q.periodStart.toISOString().slice(0, 10);
  const periodEnd = q.periodEnd.toISOString().slice(0, 10);

  try {
    // Employee set: ACTIVE employees at the location UNION employees with
    // an existing performance_records row for this quarter here — covers
    // both stale rows of departed people and newly-scoring hires.
    type EmpRow = { id: string; employee_code: string; employee_name: string };
    const PAGE = 1000;
    const activeRows: EmpRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("employees")
        .select("id, employee_code, employee_name")
        .eq("location_id", locationId)
        .eq("active", true)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`employees read: ${error.message}`);
      activeRows.push(...((data ?? []) as EmpRow[]));
      if (!data || data.length < PAGE) break;
    }

    const { data: period, error: periodErr } = await supabase
      .from("report_periods")
      .select("id")
      .eq("year", year)
      .eq("quarter", quarter)
      .maybeSingle();
    if (periodErr) throw new Error(`report_periods read: ${periodErr.message}`);

    type BeforeRow = {
      employee_id: string;
      attendance_pct: unknown;
      on_time_pct: unknown;
      hours_worked: unknown;
      tip_rate_pct: unknown;
      employees: { employee_code: string; employee_name: string } | null;
    };
    const beforeRows: BeforeRow[] = [];
    if (period?.id) {
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("performance_records")
          .select(
            "employee_id, attendance_pct, on_time_pct, hours_worked, tip_rate_pct, employees(employee_code, employee_name)"
          )
          .eq("location_id", locationId)
          .eq("report_period_id", period.id)
          .order("employee_id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`before rows read: ${error.message}`);
        beforeRows.push(...((data ?? []) as unknown as BeforeRow[]));
        if (!data || data.length < PAGE) break;
      }
    }
    const beforeByEmployee = new Map(beforeRows.map((r) => [String(r.employee_id), r]));

    const employees = new Map<string, EmpRow>();
    for (const e of (activeRows ?? []) as EmpRow[]) employees.set(e.id, e);
    for (const r of beforeRows) {
      if (!employees.has(String(r.employee_id))) {
        employees.set(String(r.employee_id), {
          id: String(r.employee_id),
          employee_code: r.employees?.employee_code ?? "?",
          employee_name: r.employees?.employee_name ?? "?",
        });
      }
    }

    // Non-puncher markers + crosswalk mapping presence, for null reasons.
    // A null that cannot say WHICH kind of null it is has only solved half
    // the problem (spec 2026-08-25 §5a): "no crosswalk row", "cover-
    // dominated schedule", "non-puncher" and "genuinely not scheduled" are
    // four different facts that must not render as one string.
    const nonPunchers = new Set<string>();
    const mapped = new Set<string>();
    {
      const ids = [...employees.keys()];
      for (let i = 0; i < ids.length; i += 100) {
        const chunkIds = ids.slice(i, i + 100);
        const { data, error } = await supabase
          .from("employees")
          .select("id, punches_time_clock")
          .in("id", chunkIds)
          .eq("punches_time_clock", false);
        // A dropped error here would silently mislabel null reasons.
        if (error) throw new Error(`non-puncher read: ${error.message}`);
        for (const r of data ?? []) nonPunchers.add(String(r.id));
        const { data: mapRows, error: mapErr } = await supabase
          .from("v_mapped_employees")
          .select("employee_id")
          .eq("location_id", locationId)
          .in("employee_id", chunkIds);
        if (mapErr) throw new Error(`mapped-set read: ${mapErr.message}`);
        for (const r of mapRows ?? []) mapped.add(String(r.employee_id));
      }
    }

    // "After" via the PURE compute — persists nothing in either mode.
    const reports: EmployeeReport[] = [];
    const failures: string[] = [];
    const queue = [...employees.values()];
    async function worker() {
      for (;;) {
        const emp = queue.shift();
        if (!emp) return;
        const r = await computeMetricsForRange(
          supabase,
          emp.id,
          locationId,
          periodStart,
          periodEnd
        );
        if (!r.ok) {
          failures.push(`${emp.employee_code}: ${r.error}`);
          continue;
        }
        const m = r.metrics;
        const b = beforeByEmployee.get(emp.id);
        const before = {
          attendance_pct: round1(num(b?.attendance_pct)),
          on_time_pct: round1(num(b?.on_time_pct)),
          hours_worked: round1(num(b?.hours_worked)),
          tip_rate_pct: round1(num(b?.tip_rate_pct)),
        };
        const after = {
          attendance_pct: round1(m.attendance_pct),
          on_time_pct: round1(m.on_time_pct),
          hours_worked: round1(m.hours_worked),
          tip_rate_pct: round1(m.tip_rate_pct),
        };
        reports.push({
          employee_id: emp.id,
          employee_name: emp.employee_name,
          employee_code: emp.employee_code,
          before,
          after,
          delta_attendance_pp:
            before.attendance_pct !== null && after.attendance_pct !== null
              ? round1(after.attendance_pct - before.attendance_pct)
              : null,
          scheduled_days: m.scheduled_count,
          attended_days: m.attended_count,
          // worked_days = days with worked evidence: attended scheduled
          // days + covered (worked-without-schedule) days.
          worked_days: m.attended_count + m.covered_shifts,
          null_reason:
            m.attendance_pct !== null
              ? null
              : nonPunchers.has(emp.id)
                ? "non-puncher exclusion (mig 056)"
                : m.cover_dominated
                  ? `cover-dominated schedule (${m.covered_shifts} covers vs ${m.scheduled_count} scheduled) — schedule record not trustworthy; anomaly, not absence`
                  : !mapped.has(emp.id)
                    ? "unmapped — EPD cannot see this employee's punches (Build 2 blindness; see the crosswalk reverse check)"
                    : "no scheduled shifts in window (genuinely unscheduled)",
        });
      }
    }
    await Promise.all(Array.from({ length: COMPUTE_CONCURRENCY }, worker));
    reports.sort((a, b) => a.employee_code.localeCompare(b.employee_code));

    // Day-weighted store attendance. AFTER = summed numerators/denominators
    // (the combining rule). BEFORE approximated by weighting each stored
    // pct with the CURRENT scheduled-day counts — pre-flip counts were
    // never persisted; the approximation is stated, not hidden (§7).
    let schedSum = 0;
    let attendedSum = 0;
    let beforeWeighted = 0;
    let beforeWeight = 0;
    for (const r of reports) {
      schedSum += r.scheduled_days;
      // Exact summed counts from the compute — never reconstructed from a
      // rounded percentage (Codex 2026-08-25; the combining rule).
      attendedSum += r.attended_days;
      if (r.before.attendance_pct !== null && r.scheduled_days > 0) {
        beforeWeighted += r.before.attendance_pct * r.scheduled_days;
        beforeWeight += r.scheduled_days;
      }
    }

    const summary = {
      location: loc.location_code,
      quarter: quarterLabel,
      window: { since: periodStart, until: periodEnd },
      mode: write ? "write" : "dry_run",
      employees_touched: reports.length,
      attendance_movers_over_10pp: reports
        .filter((r) => r.delta_attendance_pp !== null && Math.abs(r.delta_attendance_pp) > 10)
        .map((r) => ({
          employee: `${r.employee_code} ${r.employee_name}`,
          before: r.before.attendance_pct,
          after: r.after.attendance_pct,
          delta: r.delta_attendance_pp,
        })),
      became_null: reports
        .filter((r) => r.before.attendance_pct !== null && r.after.attendance_pct === null)
        .map((r) => ({
          employee: `${r.employee_code} ${r.employee_name}`,
          reason: r.null_reason,
        })),
      // The cover-ratio anomaly surface (loud, never a silent null): every
      // employee whose schedule record the guard refused to publish
      // against, whether or not they were previously null.
      cover_dominated_anomalies: reports
        .filter((r) => r.null_reason?.startsWith("cover-dominated"))
        .map((r) => ({
          employee: `${r.employee_code} ${r.employee_name}`,
          scheduled_days: r.scheduled_days,
          worked_days: r.worked_days,
          reason: r.null_reason,
        })),
      store_attendance_day_weighted: {
        before: beforeWeight > 0 ? round1(beforeWeighted / beforeWeight) : null,
        before_note:
          "weighted with CURRENT scheduled-day counts — pre-flip counts were not persisted",
        after: schedSum > 0 ? round1((attendedSum / schedSum) * 100) : null,
      },
      compute_failures: failures,
    };

    if (!write) {
      return NextResponse.json({ ...summary, employees: reports });
    }

    // WRITE: runRecomputeJobs verbatim — the same idempotent path every
    // importer uses. The report above is the RECORD of what moves, so the
    // job set is exactly the reported set — and a write with compute
    // failures would touch employees the report cannot account for, so it
    // is refused instead (Codex 2026-08-25).
    if (failures.length > 0) {
      return NextResponse.json(
        {
          ...summary,
          employees: reports,
          error: `refusing write: ${failures.length} employee(s) failed the report compute — a write must not touch what the report cannot account for`,
        },
        { status: 409 }
      );
    }
    const jobs: RecomputeJob[] = reports.map((r) => ({
      employee_id: r.employee_id,
      year,
      quarter,
    }));
    const rc = await runRecomputeJobs(supabase, locationId, jobs, {
      allowFrozenQuarter: overrideFrozenQuarter,
    });

    // created / updated / skipped reported SEPARATELY (§3) — "employees
    // touched" concealed two row-conjuring incidents.
    return NextResponse.json({
      ...summary,
      employees: reports,
      recomputed: rc.recomputed,
      records_created: rc.created,
      records_updated: rc.updated,
      records_skipped_no_activity: rc.skipped_no_activity,
      recompute_failures: rc.failures,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[recompute-quarter] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
