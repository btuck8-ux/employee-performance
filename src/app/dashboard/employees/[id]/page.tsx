import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatHireDate, formatTenure } from "@/lib/format";

export default async function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: emp } = await supabase
    .from("employees")
    .select("id, employee_name, external_id, hire_date, active, locations(id, name, clients(id, name))")
    .eq("id", id)
    .single();
  if (!emp) notFound();

  const loc = emp.locations as unknown as { id: string; name: string; clients: { id: string; name: string } | null } | null;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-slate-500">
          {loc && (
            <Link href={`/dashboard/locations/${loc.id}`} className="hover:underline">
              ← {loc.name}
            </Link>
          )}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">{emp.employee_name}</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="text-sm grid grid-cols-1 md:grid-cols-2 gap-y-2 gap-x-6">
            <div>
              <dt className="text-slate-500">Employee ID</dt>
              <dd>{emp.external_id ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Location</dt>
              <dd>{loc?.name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Hire date</dt>
              <dd>{emp.hire_date ? formatHireDate(emp.hire_date) : "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Tenure</dt>
              <dd>{emp.hire_date ? formatTenure(emp.hire_date) : "—"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Performance history</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">
            Performance records will appear here after data is uploaded (Phase 2).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
