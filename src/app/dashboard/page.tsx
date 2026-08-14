import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { ScopeControls } from "@/components/overview/ScopeControls";
import {
  OVERVIEW_METRICS,
  computeQuarterOverview,
  computeRangeOverview,
  type MetricCells,
  type OverviewMetricsResult,
} from "@/lib/overview-metrics";

// Custom-range mode fans computeMetricsForRange out per employee (kickoff
// §5a / §8-E override) — a full-purview pull needs the long ceiling.
export const maxDuration = 300;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pickStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

function formatCell(kind: string, mean: number | null): string {
  if (mean === null) return "—";
  return kind === "rating" ? `${mean.toFixed(2)}` : `${mean.toFixed(1)}%`;
}

export default async function DashboardHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const supabase = await createClient();

  // RLS trims locations to the session's purview (SA = all 8); the store
  // toggle below only narrows WITHIN that purview.
  const { data: locationRows } = await supabase
    .from("locations")
    .select("id, name, location_code, active, last_data_uploaded_at")
    .order("location_code");
  const allStores = (locationRows ?? [])
    .filter((l) => l.location_code)
    .map((l) => ({
      id: l.id as string,
      name: l.name as string,
      location_code: l.location_code as string,
      active: l.active as boolean | null,
      last_data_uploaded_at: l.last_data_uploaded_at as string | null,
    }));

  // ---- Scope: ?stores=CPD,COS (default all in purview) ----
  const storesParam = pickStr(search.stores);
  const requestedCodes = storesParam
    ? storesParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : null;
  const selectedStores = requestedCodes
    ? allStores.filter((s) => requestedCodes.includes(s.location_code))
    : allStores;
  const effectiveStores = selectedStores.length > 0 ? selectedStores : allStores;

  // ---- Period: ?quarter=<report_period_id> | ?from=&to= (custom range) ----
  const { data: periodRows } = await supabase
    .from("report_periods")
    .select("id, label, period_start, period_end")
    .order("period_start", { ascending: false })
    .limit(8);
  const quarters = (periodRows ?? []).map((p) => ({
    id: p.id as string,
    label: p.label as string,
    period_start: p.period_start as string,
    period_end: p.period_end as string,
  }));
  const today = new Date().toISOString().slice(0, 10);
  const currentQuarter =
    quarters.find((q) => q.period_start <= today && today <= q.period_end) ??
    quarters[0] ??
    null;

  const fromParam = pickStr(search.from);
  const toParam = pickStr(search.to);
  const rangeMode =
    DATE_RE.test(fromParam) && DATE_RE.test(toParam) && fromParam <= toParam;
  const quarterParam = pickStr(search.quarter);
  const selectedQuarter = rangeMode
    ? null
    : (quarters.find((q) => q.id === quarterParam) ?? currentQuarter);

  // ---- Metric grid ----
  let grid: OverviewMetricsResult | null = null;
  let periodLabel = "";
  if (rangeMode) {
    grid = await computeRangeOverview(supabase, effectiveStores, fromParam, toParam);
    periodLabel = `${fromParam} → ${toParam}`;
  } else if (selectedQuarter) {
    grid = await computeQuarterOverview(supabase, effectiveStores, selectedQuarter.id);
    periodLabel = selectedQuarter.label;
  }

  // ---- KPI tiles + stale locations, scoped to the toggled stores ----
  const scopedIds = effectiveStores.map((s) => s.id);
  const [{ count: employeeCount }, { count: reportCount }] = await Promise.all([
    supabase
      .from("employees")
      .select("*", { count: "exact", head: true })
      .eq("active", true)
      .in("location_id", scopedIds),
    supabase
      .from("generated_reports")
      .select("*", { count: "exact", head: true })
      .is("superseded_at", null)
      .in("location_id", scopedIds),
  ]);

  // Request-time cutoff for "stale" locations. Server component — a
  // request-time value, not a render-purity violation.
  // eslint-disable-next-line react-hooks/purity
  const staleCutoffIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const staleLocations = effectiveStores.filter(
    (s) =>
      s.active !== false &&
      (!s.last_data_uploaded_at || s.last_data_uploaded_at < staleCutoffIso)
  );

  const renderCells = (cells: MetricCells) =>
    OVERVIEW_METRICS.map((m) => {
      const cell = cells[m.key];
      return (
        <td key={m.key} className="py-2.5 pr-4 whitespace-nowrap">
          <span className={cell.mean === null ? "text-slate-400" : "font-medium"}>
            {formatCell(m.kind, cell.mean)}
          </span>
          <span className="text-[11px] text-slate-400 ml-1.5">n={cell.n}</span>
        </td>
      );
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-slate-500 mt-1">
            Store averages for {periodLabel || "—"} ·{" "}
            {effectiveStores.length === allStores.length
              ? "all stores in your purview"
              : `${effectiveStores.length} of ${allStores.length} stores`}
          </p>
        </div>
        <ScopeControls
          stores={allStores.map((s) => ({ location_code: s.location_code, name: s.name }))}
          selectedCodes={effectiveStores.map((s) => s.location_code)}
          quarters={quarters.map((q) => ({ id: q.id, label: q.label }))}
          selectedQuarterId={selectedQuarter?.id ?? null}
          rangeFrom={rangeMode ? fromParam : null}
          rangeTo={rangeMode ? toParam : null}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Kpi label="Stores in scope" value={effectiveStores.length} />
        <Kpi label="Active employees" value={employeeCount ?? 0} />
        <Kpi label="Current reports" value={reportCount ?? 0} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Store metrics</CardTitle>
          <CardDescription>
            Unweighted mean over each store&apos;s employees for {periodLabel || "the selected period"}.
            &ldquo;—&rdquo; = not computed (never zero-filled); n = employees contributing to that cell.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!grid || grid.stores.length === 0 ? (
            <p className="text-sm text-slate-500">No stores in scope.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-500 uppercase border-b border-slate-200">
                  <tr>
                    <th className="py-2 pr-4">Store</th>
                    {OVERVIEW_METRICS.map((m) => (
                      <th key={m.key} className="py-2 pr-4">
                        {m.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {grid.stores.map((row) => (
                    <tr key={row.location_id}>
                      <td className="py-2.5 pr-4">
                        <span className="font-medium">{row.name}</span>
                        {row.location_code && (
                          <span className="text-xs text-slate-400 ml-1.5">
                            {row.location_code}
                          </span>
                        )}
                      </td>
                      {renderCells(row.cells)}
                    </tr>
                  ))}
                  <tr className="border-t-2 border-slate-200 bg-slate-50/60">
                    <td className="py-2.5 pr-4 font-semibold">
                      All selected stores
                      <span className="text-xs text-slate-400 ml-1.5 font-normal">
                        {grid.rollupEmployeeCount} records
                      </span>
                    </td>
                    {renderCells(grid.rollup)}
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Locations needing attention</CardTitle>
          <CardDescription>
            Stores in scope with no upload in the last 48 hours.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {staleLocations.length === 0 ? (
            <p className="text-sm text-slate-500">All caught up.</p>
          ) : (
            <ul className="text-sm divide-y divide-slate-100">
              {staleLocations.map((loc) => (
                <li key={loc.id} className="py-2 flex justify-between">
                  <span>{loc.name}</span>
                  <span className="text-slate-500">
                    {loc.last_data_uploaded_at
                      ? `Last upload: ${new Date(loc.last_data_uploaded_at).toLocaleString()}`
                      : "Never uploaded"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-slate-500">{label}</p>
        <p className="text-3xl font-semibold tracking-tight mt-1">{value}</p>
      </CardContent>
    </Card>
  );
}
