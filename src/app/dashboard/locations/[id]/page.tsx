import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createEmployeeAction } from "./actions";

export default async function LocationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: location } = await supabase
    .from("locations")
    .select("id, name, last_data_uploaded_at, last_report_generated_at, clients(id, name)")
    .eq("id", id)
    .single();
  if (!location) notFound();

  const client = location.clients as unknown as { id: string; name: string } | null;

  const { data: employees } = await supabase
    .from("employees")
    .select("id, employee_name, external_id, hire_date, active")
    .eq("location_id", id)
    .order("employee_name");

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-slate-500">
          {client && (
            <Link href={`/dashboard/clients/${client.id}`} className="hover:underline">
              ← {client.name}
            </Link>
          )}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">{location.name}</h1>
        <p className="text-sm text-slate-500 mt-1">
          Last upload:{" "}
          {location.last_data_uploaded_at
            ? new Date(location.last_data_uploaded_at).toLocaleString()
            : "—"}
          {" · "}
          Last report run:{" "}
          {location.last_report_generated_at
            ? new Date(location.last_report_generated_at).toLocaleString()
            : "—"}
        </p>
      </div>

      <div className="flex gap-3">
        <Button variant="outline" disabled title="Coming in Phase 2">
          Upload Data
        </Button>
        <Button variant="outline" disabled title="Coming in Phase 4">
          Generate Reports
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add employee</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createEmployeeAction} className="grid grid-cols-1 md:grid-cols-4 gap-3 max-w-3xl">
            <input type="hidden" name="location_id" value={location.id} />
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="employee_name">Name</Label>
              <Input id="employee_name" name="employee_name" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="external_id">Employee ID (optional)</Label>
              <Input id="external_id" name="external_id" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hire_date">Hire date (optional)</Label>
              <Input id="hire_date" name="hire_date" type="date" />
            </div>
            <div className="md:col-span-4">
              <Button type="submit">Add employee</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Employees</CardTitle>
        </CardHeader>
        <CardContent>
          {!employees || employees.length === 0 ? (
            <p className="text-sm text-slate-500">No employees yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {employees.map((emp) => (
                <li key={emp.id} className="py-3 flex items-center justify-between">
                  <div>
                    <Link
                      href={`/dashboard/employees/${emp.id}`}
                      className="font-medium hover:underline"
                    >
                      {emp.employee_name}
                    </Link>
                    {emp.external_id && (
                      <p className="text-xs text-slate-500">ID: {emp.external_id}</p>
                    )}
                  </div>
                  <span className="text-xs text-slate-500">
                    {emp.hire_date
                      ? `Hired ${new Date(emp.hire_date).toLocaleDateString()}`
                      : "No hire date"}
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
