import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTenure } from "@/lib/format";

export default async function EmployeesPage() {
  const supabase = await createClient();
  const { data: employees } = await supabase
    .from("employees")
    .select("id, employee_code, employee_name, hire_date, wage, wage_pay_type, active, locations(id, name)")
    .eq("active", true)
    .order("employee_name");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
        <p className="text-sm text-slate-500 mt-1">All active employees across all locations.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>All employees</CardTitle>
        </CardHeader>
        <CardContent>
          {!employees || employees.length === 0 ? (
            <p className="text-sm text-slate-500">No employees yet.</p>
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
