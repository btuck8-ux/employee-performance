import Link from "next/link";
import { getSessionRole } from "@/lib/authz";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTenure } from "@/lib/format";
import { EmployeeStatusButton } from "@/components/employee/EmployeeStatusButton";
import { fetchActiveSiblingStoresMap } from "@/lib/active-sibling-stores";
import { createCpClient } from "@/lib/ingest/culture-pulse/client";
import { countPendingDetections } from "@/lib/triage/detections";

type SearchParams = Record<string, string | string[] | undefined>;

function pickStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const search = await searchParams;
  const filterLocation = pickStr(search.location);
  const filterClient = pickStr(search.client);
  const filterStatus = pickStr(search.status); // "" | "active" | "inactive" | "all"
  const status = filterStatus || "active"; // default
  // Search text: `,` `(` `)` are structural in PostgREST's .or() syntax;
  // `%`/`\`/`_` are LIKE metacharacters and PostgREST maps `*` to `%` —
  // neutralize rather than reject, so a paste with punctuation degrades to a
  // literal-ish match instead of a 400 or a silent match-everything.
  const rawQ = pickStr(search.q);
  const filterQ = rawQ.replace(/[,()%\\*_]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

  const { role, supabase } = await getSessionRole();
  // Deactivate/reactivate renders for admin/manager tiers (Tucker's §8-B
  // ruling 2026-08-14 extends it beyond SA); the server action re-checks
  // tier + row scope regardless. RLS already trims rows to purview.
  const canToggleStatus = role !== null && role !== "user";

  // SA-only triage chip (kickoff-employee-triage-mint-ui 2026-08-21 §5-C).
  // The count crosses to CP — if the bridge is unreachable (e.g. local dev
  // without CP env) the chip still renders, just without a number.
  let pendingDetections: number | null = null;
  if (role === "system_admin") {
    try {
      pendingDetections = await countPendingDetections(createCpClient(), supabase);
    } catch (err) {
      console.warn("[employees] detection count unavailable", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Locations + clients lists (for the dropdowns).
  const { data: locationsData } = await supabase
    .from("locations")
    .select("id, name, client_id, clients(id, name)")
    .order("name");
  type LocationRow = {
    id: string;
    name: string;
    client_id: string;
    clients: { id: string; name: string } | null;
  };
  const allLocations = ((locationsData ?? []) as unknown as LocationRow[]).map((l) => ({
    id: l.id,
    name: l.name,
    client_id: l.client_id,
    client_name: l.clients?.name ?? null,
  }));
  const allClients = Array.from(
    new Map(
      allLocations
        .filter((l) => l.client_name)
        .map((l) => [l.client_id, { id: l.client_id, name: l.client_name as string }])
    ).values()
  ).sort((a, b) => a.name.localeCompare(b.name));

  // If a client is selected (but not a location), narrow the location list shown
  // in the dropdown to that client's locations.
  const visibleLocations = filterClient
    ? allLocations.filter((l) => l.client_id === filterClient)
    : allLocations;

  // ---- Employee query with the selected filters applied ----
  let q = supabase
    .from("employees")
    .select(
      "id, employee_code, employee_name, hire_date, wage, wage_pay_type, active, is_general_manager, seven_shifts_user_id, locations!inner(id, name, client_id)"
    )
    .order("employee_name");

  if (status === "active") q = q.eq("active", true);
  else if (status === "inactive") q = q.eq("active", false);
  // status === "all" → no filter

  if (filterLocation) {
    q = q.eq("location_id", filterLocation);
  } else if (filterClient) {
    // Filter on the joined location's client_id
    q = q.eq("locations.client_id", filterClient);
  }

  // Name-or-code search composes WITH the filters above — same purview-scoped
  // query, no separate search path.
  if (filterQ) {
    q = q.or(`employee_name.ilike.%${filterQ}%,employee_code.ilike.%${filterQ}%`);
  }

  const { data: employees } = await q;

  // §7b: multi-store people get the "also deactivate at [other stores]?"
  // prompt — one batched, purview-scoped sibling lookup for the whole list.
  const siblingStores = canToggleStatus
    ? await fetchActiveSiblingStoresMap(
        supabase,
        (employees ?? []).map((e) => ({
          id: String(e.id),
          seven_shifts_user_id:
            (e.seven_shifts_user_id as number | string | null) ?? null,
        }))
      )
    : new Map<string, never[]>();

  // Build the description line.
  let scopeDesc: string;
  if (filterLocation) {
    const l = allLocations.find((x) => x.id === filterLocation);
    scopeDesc = l ? l.name : "Unknown location";
  } else if (filterClient) {
    const c = allClients.find((x) => x.id === filterClient);
    scopeDesc = c ? `All locations under ${c.name}` : "Unknown client";
  } else {
    scopeDesc = "All locations across all clients";
  }
  const returnToParams = new URLSearchParams();
  if (filterClient) returnToParams.set("client", filterClient);
  if (filterLocation) returnToParams.set("location", filterLocation);
  if (filterStatus) returnToParams.set("status", filterStatus);
  if (filterQ) returnToParams.set("q", filterQ);
  const returnTo = `/dashboard/employees${returnToParams.size > 0 ? `?${returnToParams}` : ""}`;

  const statusDesc =
    status === "active" ? "active employees" : status === "inactive" ? "inactive employees" : "all employees";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
          <p className="text-sm text-slate-500 mt-1">
            {scopeDesc} · {statusDesc}
            {filterQ ? ` · matching “${filterQ}”` : ""} · {employees?.length ?? 0} shown
          </p>
        </div>
        {role === "system_admin" && (
          <Link
            href="/dashboard/admin/employee-triage"
            className={`inline-flex shrink-0 items-center rounded-full border px-3 py-1 text-xs ${
              pendingDetections !== null && pendingDetections > 0
                ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
                : "border-slate-300 text-slate-600 hover:bg-slate-100"
            }`}
          >
            Detected employees
            {pendingDetections !== null ? ` (${pendingDetections})` : ""}
          </Link>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Client</label>
              <select
                name="client"
                defaultValue={filterClient}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm min-w-[200px]"
              >
                <option value="">All clients</option>
                {allClients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Location</label>
              <select
                name="location"
                defaultValue={filterLocation}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm min-w-[220px]"
              >
                <option value="">All locations</option>
                {visibleLocations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Status</label>
              <select
                name="status"
                defaultValue={status}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="all">All</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Search</label>
              <input
                type="search"
                name="q"
                defaultValue={filterQ}
                placeholder="Name or employee ID…"
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm min-w-[220px]"
              />
            </div>
            <button
              type="submit"
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
            >
              Apply
            </button>
            {(filterLocation || filterClient || filterQ || status !== "active") && (
              <Link
                href="/dashboard/employees"
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
          <CardTitle>Employees</CardTitle>
        </CardHeader>
        <CardContent>
          {!employees || employees.length === 0 ? (
            <p className="text-sm text-slate-500">No employees match these filters.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500 uppercase border-b border-slate-200">
                <tr>
                  <th className="py-2 pr-4">Employee ID</th>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Location</th>
                  <th className="py-2 pr-4">Hire date</th>
                  <th className="py-2 pr-4">Tenure</th>
                  <th className="py-2 pr-4">Wage</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Reports</th>
                  {canToggleStatus && <th className="py-2 pr-4">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {employees.map((emp) => {
                  const loc = emp.locations as unknown as { id: string; name: string } | null;
                  return (
                    <tr key={emp.id}>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-600">
                        {emp.employee_code}
                      </td>
                      <td className="py-2 pr-4">
                        <Link
                          href={`/dashboard/employees/${emp.id}`}
                          className="font-medium hover:underline"
                        >
                          {emp.employee_name}
                        </Link>
                        {emp.is_general_manager === true && (
                          <span
                            className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600"
                            title="General manager — punch patterns are expected to be irregular (offsite work, on-call time that never reaches a time clock)"
                          >
                            GM
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {loc ? (
                          <Link
                            href={`/dashboard/locations/${loc.id}`}
                            className="hover:underline"
                          >
                            {loc.name}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {emp.hire_date ? new Date(emp.hire_date).toLocaleDateString() : "—"}
                      </td>
                      <td className="py-2 pr-4">
                        {emp.hire_date ? formatTenure(emp.hire_date) : "—"}
                      </td>
                      <td className="py-2 pr-4">
                        {emp.wage !== null
                          ? `$${Number(emp.wage).toFixed(2)}${
                              emp.wage_pay_type ? ` ${emp.wage_pay_type.toLowerCase()}` : ""
                            }`
                          : "—"}
                      </td>
                      <td className="py-2 pr-4 text-xs">
                        {emp.active ? (
                          <span className="text-emerald-700">Active</span>
                        ) : (
                          <span className="text-slate-500">Inactive</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-xs">
                        <Link
                          href={`/dashboard/employees/${emp.id}#reports`}
                          className="text-ikes-blue underline-offset-2 hover:underline"
                        >
                          Reports
                        </Link>
                      </td>
                      {canToggleStatus && (
                        <td className="py-2 pr-4 text-xs">
                          {loc && (
                            <EmployeeStatusButton
                              employeeId={emp.id}
                              locationId={loc.id}
                              employeeName={emp.employee_name}
                              active={!!emp.active}
                              returnTo={returnTo}
                              otherActiveStores={siblingStores.get(emp.id) ?? []}
                            />
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
