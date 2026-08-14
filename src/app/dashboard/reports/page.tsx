import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSessionRole } from "@/lib/authz";
import { SubmitButton } from "@/components/ui/submit-button";
import { ReportViewer } from "@/components/reports/ReportViewer";
import { generateReportsBuilderAction } from "./builder-actions";

// The builder can fan out over a whole location (PDF render per employee) —
// reuse the bulk-generation ceiling.
export const maxDuration = 300;

type SearchParams = Record<string, string | string[] | undefined>;

function pickStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

export default async function ReportsArchivePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const search = await searchParams;
  const filterLocation = pickStr(search.location);
  const filterKind = pickStr(search.kind); // "" | "performance" | "task_detail"
  const filterMode = pickStr(search.mode); // "" | "quarterly" | "custom_range"
  const includeSuperseded = pickStr(search.include_superseded) === "1";

  const { role, supabase } = await getSessionRole();
  const isSA = role === "system_admin";
  const builderLocation = pickStr(search.builder_location);
  const builderError = pickStr(search.builder_error);
  const generatedParam = pickStr(search.generated);
  const generatedIds = generatedParam
    ? generatedParam
        .split(",")
        .filter((x) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x)
        )
    : [];

  // Locations dropdown
  const { data: locations } = await supabase
    .from("locations")
    .select("id, name, clients(name)")
    .order("name");
  type LocationRow = {
    id: string;
    name: string;
    clients: { name: string } | null;
  };
  const locationList = ((locations ?? []) as unknown as LocationRow[]).map((l) => ({
    id: l.id,
    name: l.name,
    client_name: l.clients?.name ?? null,
  }));

  // ---- Builder data (SA only): quarters + employees at picked location ----
  const { data: periodRows } = isSA
    ? await supabase
        .from("report_periods")
        .select("id, label, period_start")
        .order("period_start", { ascending: false })
        .limit(8)
    : { data: null };
  const builderQuarters = (periodRows ?? []).map((p) => ({
    id: p.id as string,
    label: p.label as string,
  }));
  const { data: builderEmployeeRows } =
    isSA && builderLocation
      ? await supabase
          .from("employees")
          .select("id, employee_name, employee_code")
          .eq("location_id", builderLocation)
          .eq("active", true)
          .order("employee_name")
      : { data: null };
  const builderEmployees = (builderEmployeeRows ?? []).map((e) => ({
    id: e.id as string,
    name: e.employee_name as string,
    code: (e.employee_code as string | null) ?? "",
  }));

  // ---- "Generated this visit" list ----
  const { data: generatedRows } =
    generatedIds.length > 0
      ? await supabase
          .from("generated_reports")
          .select(
            "id, generation_mode, custom_range, report_kind, employees(employee_name), report_periods(label)"
          )
          .in("id", generatedIds)
      : { data: null };
  type GeneratedRow = {
    id: string;
    generation_mode: string;
    custom_range: { start: string; end: string } | null;
    report_kind: string;
    employees: { employee_name: string } | null;
    report_periods: { label: string } | null;
  };
  const generatedReports = ((generatedRows ?? []) as unknown as GeneratedRow[]).map(
    (r) => ({
      id: r.id,
      label: `${r.employees?.employee_name ?? "—"} · ${
        r.generation_mode === "custom_range" && r.custom_range
          ? `${r.custom_range.start} → ${r.custom_range.end}`
          : (r.report_periods?.label ?? "—")
      }`,
    })
  );

  // Reports list
  let q = supabase
    .from("generated_reports")
    .select(
      `id, generation_mode, report_kind, custom_range, storage_path,
       generated_at, superseded_at, feedback_updated_after_generation,
       employees(id, employee_name, employee_code),
       locations(id, name),
       report_periods(label)`
    )
    .order("generated_at", { ascending: false })
    .limit(500);
  if (filterLocation) q = q.eq("location_id", filterLocation);
  if (filterKind) q = q.eq("report_kind", filterKind);
  if (filterMode) q = q.eq("generation_mode", filterMode);
  if (!includeSuperseded) q = q.is("superseded_at", null);

  const { data: rawReports } = await q;

  type ReportRow = {
    id: string;
    generation_mode: string;
    report_kind: string;
    custom_range: { start: string; end: string } | null;
    storage_path: string;
    generated_at: string;
    superseded_at: string | null;
    feedback_updated_after_generation: boolean;
    employees: { id: string; employee_name: string; employee_code: string } | null;
    locations: { id: string; name: string } | null;
    report_periods: { label: string } | null;
  };
  const reports = ((rawReports ?? []) as unknown as ReportRow[]).map((r) => ({
    id: r.id,
    generation_mode: r.generation_mode,
    report_kind: r.report_kind,
    period:
      r.generation_mode === "custom_range" && r.custom_range
        ? `${r.custom_range.start} → ${r.custom_range.end}`
        : (r.report_periods?.label ?? "—"),
    employee_name: r.employees?.employee_name ?? "—",
    employee_id: r.employees?.id ?? null,
    employee_code: r.employees?.employee_code ?? "",
    location_name: r.locations?.name ?? "—",
    generated_at: r.generated_at,
    superseded: !!r.superseded_at,
    stale: r.feedback_updated_after_generation,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-slate-500 mt-1">
          Custom report builder. Each employee&apos;s full report archive lives on
          their profile&apos;s Reports section; the browse table below spans your
          whole purview.
        </p>
      </div>

      {builderError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {builderError}
        </div>
      )}

      {isSA && (
        <Card>
          <CardHeader>
            <CardTitle>Build reports</CardTitle>
            <CardDescription>
              Pick a location, narrow to specific employees (or leave unchecked
              for everyone active), choose a period, then generate. Quarterly
              uses the canonical per-quarter records; custom range recomputes
              from raw data.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form method="get" className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Location</label>
                <select
                  name="builder_location"
                  defaultValue={builderLocation}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm min-w-[240px]"
                >
                  <option value="">Pick a location…</option>
                  {locationList.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.client_name ? `${l.client_name} — ${l.name}` : l.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
              >
                Load employees
              </button>
            </form>

            {builderLocation && (
              <form action={generateReportsBuilderAction} className="space-y-4">
                <input type="hidden" name="location_id" value={builderLocation} />
                <div>
                  <p className="text-xs text-slate-500 mb-2">
                    Employees ({builderEmployees.length} active — none checked =
                    all)
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-1 max-h-56 overflow-y-auto rounded-md border border-slate-200 p-3">
                    {builderEmployees.map((e) => (
                      <label
                        key={e.id}
                        className="flex items-center gap-2 text-sm py-0.5 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          name="employee_ids"
                          value={e.id}
                          className="h-4 w-4 accent-[#702F8A]"
                        />
                        <span className="truncate">{e.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-end gap-4">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Period</label>
                    <select
                      name="period_mode"
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                      defaultValue="quarter"
                    >
                      <option value="quarter">Quarter</option>
                      <option value="range">Custom range</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Quarter</label>
                    <select
                      name="report_period_id"
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                      defaultValue={builderQuarters[0]?.id ?? ""}
                    >
                      {builderQuarters.map((q2) => (
                        <option key={q2.id} value={q2.id}>
                          {q2.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">
                      Range start (custom)
                    </label>
                    <input
                      type="date"
                      name="range_start"
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">
                      Range end (custom)
                    </label>
                    <input
                      type="date"
                      name="range_end"
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm text-slate-700 mb-1.5">
                    <input
                      type="checkbox"
                      name="include_task_detail"
                      value="1"
                      className="h-4 w-4 accent-[#702F8A]"
                    />
                    Attach task detail (quarterly)
                  </label>
                  <SubmitButton pendingLabel="Generating…">Generate</SubmitButton>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {generatedReports.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Generated this visit</CardTitle>
            <CardDescription>
              Click a report to display it inline; use the button to open a
              printable tab.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReportViewer reports={generatedReports} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Location</label>
              <select
                name="location"
                defaultValue={filterLocation}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm min-w-[200px]"
              >
                <option value="">All locations</option>
                {locationList.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.client_name ? `${l.client_name} — ${l.name}` : l.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Kind</label>
              <select
                name="kind"
                defaultValue={filterKind}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              >
                <option value="">All kinds</option>
                <option value="performance">Performance</option>
                <option value="task_detail">Task detail</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Mode</label>
              <select
                name="mode"
                defaultValue={filterMode}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              >
                <option value="">All modes</option>
                <option value="quarterly">Quarterly</option>
                <option value="custom_range">Custom range</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700 mb-1.5">
              <input
                type="checkbox"
                name="include_superseded"
                value="1"
                defaultChecked={includeSuperseded}
                className="h-4 w-4"
              />
              Include superseded
            </label>
            <button
              type="submit"
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
            >
              Apply
            </button>
            {(filterLocation || filterKind || filterMode || includeSuperseded) && (
              <Link
                href="/dashboard/reports"
                className="text-xs text-slate-600 underline self-center"
              >
                Clear all
              </Link>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Generated reports</CardTitle>
        </CardHeader>
        <CardContent>
          {reports.length === 0 ? (
            <p className="text-sm text-slate-500">
              No reports match these filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-500 uppercase border-b border-slate-200">
                  <tr>
                    <th className="py-2 pr-4">Generated</th>
                    <th className="py-2 pr-4">Employee</th>
                    <th className="py-2 pr-4">Location</th>
                    <th className="py-2 pr-4">Period</th>
                    <th className="py-2 pr-4">Mode</th>
                    <th className="py-2 pr-4">Kind</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {reports.map((r) => (
                    <tr key={r.id}>
                      <td className="py-2 pr-4 whitespace-nowrap">
                        {new Date(r.generated_at).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4">
                        {r.employee_id ? (
                          <Link
                            href={`/dashboard/employees/${r.employee_id}`}
                            className="hover:underline"
                          >
                            {r.employee_name}
                          </Link>
                        ) : (
                          r.employee_name
                        )}
                        {r.employee_code && (
                          <span className="text-xs text-slate-500 ml-1">
                            ({r.employee_code})
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4">{r.location_name}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{r.period}</td>
                      <td className="py-2 pr-4 whitespace-nowrap text-xs text-slate-600">
                        {r.generation_mode === "custom_range"
                          ? "Custom"
                          : "Quarterly"}
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap text-xs text-slate-600">
                        {r.report_kind === "task_detail"
                          ? "Task detail"
                          : "Performance"}
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap text-xs">
                        {r.superseded ? (
                          <span className="text-slate-500">Superseded</span>
                        ) : r.stale ? (
                          <span
                            className="text-amber-700"
                            title="Manager feedback was updated after this report was generated."
                          >
                            ⚠ Stale
                          </span>
                        ) : (
                          <span className="text-emerald-700">Current</span>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        <a
                          href={`/api/reports/${r.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs underline hover:text-slate-900"
                        >
                          Download
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
