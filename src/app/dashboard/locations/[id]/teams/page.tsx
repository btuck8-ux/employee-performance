import Link from "next/link";
import { notFound } from "next/navigation";

// Phase 7 dashboard route. Heaviest single query here is the team_tip_impact
// pull for a busy quarter (Longmont Q4 2025 has 783 rows), well under any
// reasonable timeout — but keep page-level maxDuration consistent with the
// other dashboard pages so future operations have headroom.
export const maxDuration = 300;

import { createClient } from "@/lib/supabase/server";
import { TeamsDashboard } from "@/components/teams/TeamsDashboard";

interface RawQuarter {
  id: string;
  label: string;
  period_start: string;
  period_end: string;
}

interface RawTeamRow {
  member_ids: string[];
  member_count: number;
  hours_together: number | string;
  sales_during: number | string;
  tips_during: number | string;
  tip_rate_pct: number | string | null;
  delta_vs_loc_pp: number | string | null;
}

interface RawPerfRow {
  employee_id: string;
  hours_worked: number | string | null;
  tip_rate_pct: number | string | null;
  tip_per_hour: number | string | null;
  location_tip_rate_pct: number | string | null;
  location_tip_per_hour: number | string | null;
  tip_rate_delta_pp: number | string | null;
  sales_during_presence: number | string | null;
  tips_during_presence: number | string | null;
}

function toNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isNaN(n) ? null : n;
}

export default async function TeamsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const search = await searchParams;
  const supabase = await createClient();

  // ---- Location header info ----
  const { data: location } = await supabase
    .from("locations")
    .select("id, name, clients(id, name)")
    .eq("id", id)
    .single();
  if (!location) notFound();
  const client =
    location.clients as unknown as { id: string; name: string } | null;

  // ---- Active employees (drives the heatmap axis + name resolution) ----
  const { data: employeesRaw } = await supabase
    .from("employees")
    .select("id, employee_name")
    .eq("location_id", id)
    .eq("active", true)
    .order("employee_name");
  const employees =
    (employeesRaw ?? []) as Array<{ id: string; employee_name: string }>;
  const employeeById = new Map(employees.map((e) => [e.id, e.employee_name]));

  // ---- Available quarters: union of (team_tip_impact ∪ performance_records)
  // so the dropdown shows every quarter we *could* render — even ones where
  // POS data hasn't been ingested yet, so the operator gets the scatter view
  // even before tip data exists.
  const [teamPeriodsRes, perfPeriodsRes, salesRangeRes] = await Promise.all([
    supabase
      .from("team_tip_impact")
      .select("report_periods!inner(id, label, period_start, period_end)")
      .eq("location_id", id),
    supabase
      .from("performance_records")
      .select("report_periods!inner(id, label, period_start, period_end)")
      .eq("location_id", id),
    supabase
      .from("sales_records")
      .select("transaction_at")
      .eq("location_id", id)
      .order("transaction_at", { ascending: true })
      .limit(1),
  ]);
  const earliestSalesDate =
    ((salesRangeRes.data?.[0] as { transaction_at: string } | undefined)
      ?.transaction_at?.slice(0, 10)) ?? null;
  const todayIso = new Date().toISOString().slice(0, 10);
  const seenPeriods = new Map<string, RawQuarter>();
  for (const row of (teamPeriodsRes.data ?? []) as unknown as Array<{
    report_periods: RawQuarter | null;
  }>) {
    if (row.report_periods) seenPeriods.set(row.report_periods.id, row.report_periods);
  }
  for (const row of (perfPeriodsRes.data ?? []) as unknown as Array<{
    report_periods: RawQuarter | null;
  }>) {
    if (row.report_periods) seenPeriods.set(row.report_periods.id, row.report_periods);
  }
  const quarters = Array.from(seenPeriods.values()).sort((a, b) =>
    b.period_start.localeCompare(a.period_start)
  );

  // ---- Resolve selected quarter ----
  const requestedQuarter = typeof search.q === "string" ? search.q : null;
  const selectedQuarter =
    quarters.find((q) => q.id === requestedQuarter) ?? quarters[0] ?? null;

  // ---- Per-employee performance for the scatter ----
  let scatterRows: Array<{
    employeeId: string;
    employeeName: string;
    hoursWorked: number;
    tipRatePct: number;
    locationTipRatePct: number | null;
    tipRateDeltaPp: number | null;
    tipPerHour: number | null;
    sales: number | null;
    tips: number | null;
  }> = [];
  let teams: Array<{
    memberIds: string[];
    memberNames: string[];
    memberCount: number;
    hoursTogether: number;
    salesDuring: number;
    tipsDuring: number;
    tipRatePct: number | null;
    deltaVsLocPp: number | null;
  }> = [];

  if (selectedQuarter) {
    // ---- performance_records for scatter (employees with both hours AND tip
    // data; tip-only rows w/o hours can't be plotted on the X axis). ----
    const { data: prRaw } = await supabase
      .from("performance_records")
      .select(
        "employee_id, hours_worked, tip_rate_pct, tip_per_hour, location_tip_rate_pct, tip_rate_delta_pp, sales_during_presence, tips_during_presence"
      )
      .eq("location_id", id)
      .eq("report_period_id", selectedQuarter.id);
    scatterRows = ((prRaw ?? []) as unknown as RawPerfRow[])
      .map((row) => {
        const hours = toNum(row.hours_worked);
        const tipRate = toNum(row.tip_rate_pct);
        if (hours === null || hours <= 0 || tipRate === null) return null;
        return {
          employeeId: row.employee_id,
          employeeName:
            employeeById.get(row.employee_id) ?? "Unknown (former)",
          hoursWorked: hours,
          tipRatePct: tipRate,
          locationTipRatePct: toNum(row.location_tip_rate_pct),
          tipRateDeltaPp: toNum(row.tip_rate_delta_pp),
          tipPerHour: toNum(row.tip_per_hour),
          sales: toNum(row.sales_during_presence),
          tips: toNum(row.tips_during_presence),
        };
      })
      .filter(<T,>(r: T | null): r is T => r !== null);

    // ---- team_tip_impact for leaderboard + heatmap ----
    const { data: teamRaw } = await supabase
      .from("team_tip_impact")
      .select(
        "member_ids, member_count, hours_together, sales_during, tips_during, tip_rate_pct, delta_vs_loc_pp"
      )
      .eq("location_id", id)
      .eq("report_period_id", selectedQuarter.id)
      .range(0, 4999); // safety: even Longmont's 783-team max is well below this
    teams = ((teamRaw ?? []) as unknown as RawTeamRow[]).map((row) => ({
      memberIds: row.member_ids,
      memberNames: row.member_ids.map(
        (mid) => employeeById.get(mid) ?? "Unknown (former)"
      ),
      memberCount: row.member_count,
      hoursTogether: Number(row.hours_together) || 0,
      salesDuring: Number(row.sales_during) || 0,
      tipsDuring: Number(row.tips_during) || 0,
      tipRatePct: toNum(row.tip_rate_pct),
      deltaVsLocPp: toNum(row.delta_vs_loc_pp),
    }));
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-slate-500">
          {client && (
            <Link
              href={`/dashboard/locations/${id}`}
              className="hover:underline"
            >
              ← {location.name}
            </Link>
          )}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">
          {location.name} · Teams analytics
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Co-presence cohorts ranked by impact on the location&apos;s tip rate.
          A &ldquo;team&rdquo; is any distinct set of employees that were
          clocked in together. Same group of people clocked in across many
          shifts aggregates to a single team.
        </p>
      </div>

      {quarters.length === 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          No performance data yet at this location. Upload time + POS data on
          the location page to populate the teams view.
        </div>
      ) : (
        <TeamsDashboard
          quarters={quarters}
          selectedQuarterId={selectedQuarter?.id ?? null}
          locationId={id}
          employees={employees}
          scatterRows={scatterRows}
          teams={teams}
          earliestSalesDate={earliestSalesDate}
          latestSalesDate={todayIso}
        />
      )}
    </div>
  );
}
