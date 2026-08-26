import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTenure } from "@/lib/format";
import { setEmployeeTierAction } from "./actions";

/**
 * The unclassified-tier queue (CSU memo §6; Tucker: "Unclassified is a
 * fine tier value, so long as the UI prompts an admin to take a look so it
 * can be classified as soon as possible"). Steady pressure, not an alert:
 * a count on the admin index, this working surface with an inline tier
 * setter, and an inline marker in the employee list.
 *
 * Every row here is a person NOBODY has decided a tier for — new imports
 * land unclassified by default (mig 077) so no import silently asserts a
 * tier. Classifying is always a human act; nothing on this page derives.
 * SA-only, the triage-page pattern.
 */

const TIER_OPTIONS = [
  { value: "user", label: "User (crew, shift lead, AGM, team lead)" },
  { value: "manager", label: "Manager (general manager — one per store)" },
  { value: "area_admin", label: "Area admin" },
  { value: "regional_admin", label: "Regional admin" },
  { value: "system_admin", label: "System admin" },
];

export default async function UnclassifiedTiersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const { role } = await getSessionRole();
  if (role !== "system_admin") redirect("/dashboard");

  const admin = createAdminClient();
  const { data, error: readError } = await admin
    .from("employees")
    .select("id, employee_code, employee_name, hire_date, active, epd_role, locations(name)")
    .eq("epd_role", "unclassified")
    .order("employee_name");
  if (readError) throw new Error(`unclassified read: ${readError.message}`);
  type Row = {
    id: string;
    employee_code: string;
    employee_name: string;
    hire_date: string | null;
    active: boolean;
    locations: { name: string } | null;
  };
  const rows = (data ?? []) as unknown as Row[];

  const str = (v: string | string[] | undefined): string | null =>
    typeof v === "string" && v ? v : null;
  const error = str(search.error);
  const classifiedName = search.classified === "1" ? str(search.name) : null;
  const classifiedTier = str(search.tier);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Unclassified tiers
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          People no human has decided a tier for — new imports land here by
          default so nothing silently asserts one. Unclassified is a safe
          state, not a permanent one: it sweeps like crew and it should be
          classified as soon as possible. {rows.length} awaiting.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {error}
        </div>
      )}
      {classifiedName && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {classifiedName} is now {classifiedTier ?? "classified"}.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Awaiting classification</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-slate-500">
              Nobody is unclassified — every roster row carries a tier a
              human chose.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500 uppercase border-b border-slate-200">
                <tr>
                  <th className="py-2 pr-4">Employee</th>
                  <th className="py-2 pr-4">Store</th>
                  <th className="py-2 pr-4">Hire date</th>
                  <th className="py-2 pr-4">Tenure</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Set tier</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 pr-4">
                      <Link
                        href={`/dashboard/employees/${r.id}`}
                        className="font-medium hover:underline"
                      >
                        {r.employee_name}
                      </Link>
                      <span className="ml-2 font-mono text-xs text-slate-500">
                        {r.employee_code}
                      </span>
                    </td>
                    <td className="py-2 pr-4">{r.locations?.name ?? "—"}</td>
                    <td className="py-2 pr-4">
                      {r.hire_date ? new Date(r.hire_date).toLocaleDateString() : "—"}
                    </td>
                    <td className="py-2 pr-4">
                      {r.hire_date ? formatTenure(r.hire_date) : "—"}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {r.active ? (
                        <span className="text-emerald-700">Active</span>
                      ) : (
                        <span className="text-slate-500">Inactive</span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      <form
                        action={setEmployeeTierAction}
                        className="flex items-center gap-2"
                      >
                        <input type="hidden" name="employee_id" value={r.id} />
                        <select
                          name="tier"
                          defaultValue=""
                          required
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                        >
                          <option value="" disabled>
                            Choose…
                          </option>
                          {TIER_OPTIONS.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                        <Button type="submit" variant="outline" size="sm">
                          Set
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
