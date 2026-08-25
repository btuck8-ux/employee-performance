import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { UserInviteForm } from "@/components/admin/UserInviteForm";
import { revokeRoleAction } from "./actions";

/**
 * SA-only Users surface (2026-08-23 sprint §4-D2): dashboard accounts with
 * role + scope, invitation-based provisioning (no credential fields, ever —
 * §4-D3),
 * revoke as the only mutation (§4-D7), and the read-only likely-departed
 * report (§4-D9).
 *
 * Reads: user_roles/territories/locations/employees ride the AUTHENTICATED
 * client (RLS enforces); invited_at + last_sign_in_at live in auth.users
 * only, so the directory listing rides admin.auth.admin.listUsers — the
 * invite-actions.ts precedent. public.users is NOT read here: its `role`
 * column is the pre-RBAC vestige (§4-D6) and must not become a second
 * source of truth.
 */

const DEPARTED_DAYS = 60;

interface RoleRow {
  user_id: string;
  role: string;
  territory_id: string | null;
  location_ids: string[] | null;
  location_id: string | null;
  employee_id: string | null;
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const { role, supabase } = await getSessionRole();
  if (role !== "system_admin") redirect("/dashboard");

  const ok = typeof search.ok === "string" ? search.ok : null;
  const error = typeof search.error === "string" ? search.error : null;

  const admin = createAdminClient();

  // Auth directory (paged — same pattern as the invite pre-check).
  const authUsers: Array<{
    id: string;
    email: string;
    invited_at: string | null;
    last_sign_in_at: string | null;
  }> = [];
  let directoryError: string | null = null;
  for (let page = 1; page <= 10; page += 1) {
    const { data: usersPage, error: listErr } =
      await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (listErr) {
      directoryError = listErr.message;
      break;
    }
    for (const u of usersPage.users) {
      authUsers.push({
        id: u.id,
        email: u.email ?? "(no email)",
        invited_at: u.invited_at ?? null,
        last_sign_in_at: u.last_sign_in_at ?? null,
      });
    }
    if (usersPage.users.length < 1000) break;
  }

  const [
    { data: roleRows, error: rolesError },
    { data: territoryRows },
    { data: locationRows },
    { data: employeeRows },
  ] = await Promise.all([
    supabase
      .from("user_roles")
      .select(
        "user_id, role, territory_id, location_ids, location_id, employee_id"
      ),
    supabase.from("territories").select("id, name").order("name"),
    supabase.from("locations").select("id, name").order("name"),
    supabase
      .from("employees")
      .select("id, employee_code, employee_name, locations(name)")
      .eq("active", true)
      .order("employee_code"),
  ]);
  if (rolesError) throw new Error(`user_roles: ${rolesError.message}`);

  const roles = (roleRows ?? []) as RoleRow[];
  const roleByUserId = new Map(roles.map((r) => [r.user_id, r]));
  const territoryName = new Map(
    (territoryRows ?? []).map((t) => [t.id as string, t.name as string])
  );
  const locationName = new Map(
    (locationRows ?? []).map((l) => [l.id as string, l.name as string])
  );
  type EmployeeRow = {
    id: string;
    employee_code: string;
    employee_name: string;
    locations: { name: string } | null;
  };
  const employees = (employeeRows ?? []) as unknown as EmployeeRow[];
  const employeeLabel = new Map(
    employees.map((e) => [
      e.id,
      `${e.employee_code} — ${e.employee_name}`,
    ])
  );

  function scopeText(r: RoleRow): string {
    switch (r.role) {
      case "system_admin":
        return "All clients";
      case "regional_admin":
        return r.territory_id
          ? (territoryName.get(r.territory_id) ?? "Unknown territory")
          : "—";
      case "area_admin":
        return (r.location_ids ?? [])
          .map((id) => locationName.get(id) ?? "Unknown")
          .join(", ");
      case "manager":
        return r.location_id
          ? (locationName.get(r.location_id) ?? "Unknown location")
          : "—";
      case "user":
        return r.employee_id
          ? (employeeLabel.get(r.employee_id) ?? "Linked employee")
          : "Self only";
      default:
        return "—";
    }
  }

  const datePart = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
  authUsers.sort((a, b) => a.email.localeCompare(b.email));

  // ---- §4-D9 likely-departed report (read-only) ----
  // THE FLIP (2026-08-25): worked evidence at Toast stores lives in
  // toast_time_entries — an employee whose punches only exist there must
  // not age into a false 60-day departed warning (Codex). Take the LATEST
  // of both sources per employee.
  const { data: departedRaw, error: departedError } = await supabase
    .from("employees")
    .select(
      "id, employee_code, employee_name, active, locations(name), time_entries(entry_date), toast_time_entries(entry_date)"
    )
    .eq("time_entries.entry_type", "worked")
    .order("entry_date", { referencedTable: "time_entries", ascending: false })
    .limit(1, { referencedTable: "time_entries" })
    .eq("toast_time_entries.deleted", false)
    .order("entry_date", { referencedTable: "toast_time_entries", ascending: false })
    .limit(1, { referencedTable: "toast_time_entries" });
  if (departedError)
    throw new Error(`departed report: ${departedError.message}`);
  type DepartedRow = {
    id: string;
    employee_code: string;
    employee_name: string;
    active: boolean;
    locations: { name: string } | null;
    time_entries: Array<{ entry_date: string }>;
    toast_time_entries: Array<{ entry_date: string }>;
  };
  const todayMs = new Date().getTime();
  const departed = ((departedRaw ?? []) as unknown as DepartedRow[])
    .filter((e) => e.active)
    .map((e) => {
      const lastTe = e.time_entries[0]?.entry_date ?? null;
      const lastPunch = e.toast_time_entries[0]?.entry_date ?? null;
      const last =
        lastTe && lastPunch ? (lastTe > lastPunch ? lastTe : lastPunch) : (lastTe ?? lastPunch);
      const daysSince = last
        ? Math.floor(
            (todayMs - new Date(`${last}T00:00:00Z`).getTime()) / 86400_000
          )
        : null;
      return { ...e, last, daysSince };
    })
    .filter((e) => e.daysSince === null || e.daysSince > DEPARTED_DAYS)
    .sort((a, b) => (b.daysSince ?? 9e9) - (a.daysSince ?? 9e9));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-slate-500 mt-1">
          Dashboard accounts and their scopes. Provisioning is
          invitation-only; roles are granted once and revoked-then-re-granted,
          never edited in place.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {error}
        </div>
      )}
      {ok && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {ok}
        </div>
      )}
      {directoryError && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Auth directory read failed ({directoryError}) — the list below may
          be incomplete; invited/last-sign-in dates unavailable.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-3 font-medium">Email</th>
                  <th className="py-2 pr-3 font-medium">Role</th>
                  <th className="py-2 pr-3 font-medium">Scope</th>
                  <th className="py-2 pr-3 font-medium">Invited</th>
                  <th className="py-2 pr-3 font-medium">Last sign-in</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {authUsers.map((u) => {
                  const r = roleByUserId.get(u.id) ?? null;
                  return (
                    <tr key={u.id} className="border-b border-slate-100">
                      <td className="py-2 pr-3">{u.email}</td>
                      <td className="py-2 pr-3">
                        {r ? (
                          <span className="font-medium">{r.role}</span>
                        ) : (
                          <span className="text-slate-400">no role</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">{r ? scopeText(r) : "—"}</td>
                      <td className="py-2 pr-3 tabular-nums">
                        {datePart(u.invited_at)}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {datePart(u.last_sign_in_at)}
                      </td>
                      <td className="py-2 text-right">
                        {r && (
                          <form action={revokeRoleAction}>
                            <input
                              type="hidden"
                              name="user_id"
                              value={u.id}
                            />
                            <SubmitButton
                              variant="outline"
                              size="sm"
                              pendingLabel="Revoking…"
                            >
                              Revoke role
                            </SubmitButton>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invite</CardTitle>
        </CardHeader>
        <CardContent>
          <UserInviteForm
            territories={(territoryRows ?? []).map((t) => ({
              id: t.id as string,
              name: t.name as string,
            }))}
            locations={(locationRows ?? []).map((l) => ({
              id: l.id as string,
              name: l.name as string,
            }))}
            employees={employees.map((e) => ({
              id: e.id,
              label: `${e.employee_code} — ${e.employee_name}${
                e.locations?.name ? ` (${e.locations.name})` : ""
              }`,
            }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Likely departed — no worked shift in {DEPARTED_DAYS}+ days
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-slate-500">
            Read-only report ({DEPARTED_DAYS}-day default): active roster rows
            with no worked time entry recently. Deactivation stays a
            per-employee decision on each profile. Note what deactivating
            actually does: the person disappears from{" "}
            <code className="text-xs">/api/scores</code> (every period), their
            data stops updating nightly — but{" "}
            <code className="text-xs">/api/scores/range</code> still returns
            them (it reads all employees at a location, active or not). The
            asymmetry is why this is a report, not a bulk action.
          </p>
          {departed.length === 0 ? (
            <p className="text-sm text-slate-500">
              Everyone active has worked within {DEPARTED_DAYS} days.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                    <th className="py-2 pr-3 font-medium">Employee</th>
                    <th className="py-2 pr-3 font-medium">Code</th>
                    <th className="py-2 pr-3 font-medium">Location</th>
                    <th className="py-2 pr-3 font-medium">Last worked</th>
                    <th className="py-2 font-medium">Days since</th>
                  </tr>
                </thead>
                <tbody>
                  {departed.map((e) => (
                    <tr key={e.id} className="border-b border-slate-100">
                      <td className="py-2 pr-3">
                        <a
                          href={`/dashboard/employees/${e.id}`}
                          className="hover:underline"
                        >
                          {e.employee_name}
                        </a>
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {e.employee_code}
                      </td>
                      <td className="py-2 pr-3">{e.locations?.name ?? "—"}</td>
                      <td className="py-2 pr-3 tabular-nums">
                        {e.last ?? "never"}
                      </td>
                      <td className="py-2 tabular-nums">
                        {e.daysSince ?? "—"}
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
