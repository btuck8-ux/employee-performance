import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateEmployeeAction } from "./actions";

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50";

interface ClientWithLocations {
  id: string;
  name: string;
  locations: { id: string; name: string }[];
}

export default async function EditEmployeePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const search = await searchParams;
  const supabase = await createClient();

  const [empRes, clientsRes] = await Promise.all([
    supabase
      .from("employees")
      .select(
        "id, employee_code, employee_name, email, phone, hire_date, wage, wage_pay_type, active, location_id, punches_time_clock, punches_time_clock_since"
      )
      .eq("id", id)
      .single(),
    supabase
      .from("clients")
      .select("id, name, locations(id, name)")
      .order("name"),
  ]);

  const emp = empRes.data;
  if (!emp) notFound();

  const clients = (clientsRes.data ?? []) as unknown as ClientWithLocations[];
  const error = typeof search.error === "string" ? search.error : null;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-slate-500">
          <Link href={`/dashboard/employees/${emp.id}`} className="hover:underline">
            ← Back to {emp.employee_name}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">
          Edit {emp.employee_name}
        </h1>
        <p className="text-sm text-slate-500 mt-1 font-mono">{emp.employee_code}</p>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>Save failed:</strong> {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Employee details</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={updateEmployeeAction} className="space-y-4 max-w-2xl">
            <input type="hidden" name="id" value={emp.id} />

            <div className="space-y-1.5">
              <Label htmlFor="employee_name">Name</Label>
              <Input
                id="employee_name"
                name="employee_name"
                defaultValue={emp.employee_name}
                required
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  defaultValue={emp.email ?? ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  name="phone"
                  type="tel"
                  defaultValue={emp.phone ?? ""}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="location_id">Location</Label>
              <select
                id="location_id"
                name="location_id"
                defaultValue={emp.location_id}
                className={SELECT_CLASS}
                required
              >
                {clients.map((client) => (
                  <optgroup key={client.id} label={client.name}>
                    {(client.locations ?? []).map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="text-xs text-slate-500">
                Choose any location across any client to transfer this employee. Their
                performance history will follow.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="hire_date">Hire date</Label>
                <Input
                  id="hire_date"
                  name="hire_date"
                  type="date"
                  defaultValue={emp.hire_date ?? ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wage">Wage</Label>
                <Input
                  id="wage"
                  name="wage"
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue={emp.wage !== null ? String(emp.wage) : ""}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="wage_pay_type">Pay type</Label>
              <select
                id="wage_pay_type"
                name="wage_pay_type"
                defaultValue={emp.wage_pay_type ?? ""}
                className={SELECT_CLASS}
              >
                <option value="">— None —</option>
                <option value="Hourly">Hourly</option>
                <option value="Salary">Salary</option>
              </select>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <input
                id="active"
                name="active"
                type="checkbox"
                defaultChecked={emp.active}
                value="1"
                className="h-4 w-4 rounded border-slate-300"
              />
              <Label htmlFor="active">Active employee</Label>
            </div>
            <p className="text-xs text-slate-500 -mt-2">
              Uncheck to mark inactive. Inactive employees are kept in the database but hidden
              from the main Employees list.
            </p>

            <div className="flex items-center gap-2 pt-2">
              {/* Sentinel: an unchecked checkbox and an absent field are
                  indistinguishable in a POST — without this, a stale or
                  partial form would silently flip someone to non-puncher
                  (Codex 2026-08-24). The action only writes the field when
                  the sentinel arrived with it. */}
              <input type="hidden" name="punches_time_clock_present" value="1" />
              <input
                id="punches_time_clock"
                name="punches_time_clock"
                type="checkbox"
                defaultChecked={emp.punches_time_clock !== false}
                value="1"
                className="h-4 w-4 rounded border-slate-300"
              />
              <Label htmlFor="punches_time_clock">Punches the time clock</Label>
            </div>
            <p className="text-xs text-slate-500 -mt-2">
              Uncheck only for an evidenced non-puncher (salaried, zero clock-ins
              against a real schedule). Excludes them from punch-based attendance
              (reads as not-computable, never 0%). This setting is yours alone —
              no CSV upload or ingest ever changes it, and it is deliberately not
              tied to pay type: most salaried GMs punch normally.
            </p>

            <div className="space-y-1.5">
              <Label htmlFor="punches_time_clock_since">Non-puncher since</Label>
              <Input
                id="punches_time_clock_since"
                name="punches_time_clock_since"
                type="date"
                defaultValue={emp.punches_time_clock_since ?? ""}
              />
              <p className="text-xs text-slate-500">
                When they stopped punching (e.g. their store&apos;s Toast go-live).
                Periods ending before this date keep their real attendance history;
                only periods overlapping it read as not-computable. Leave blank for
                someone who has never punched. Ignored while the box above is
                checked.
              </p>
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="submit">Save changes</Button>
              <Button type="button" variant="outline" asChild>
                <Link href={`/dashboard/employees/${emp.id}`}>Cancel</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
