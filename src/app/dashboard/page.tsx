import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardHome() {
  const supabase = await createClient();

  const [{ count: locationCount }, { count: employeeCount }, { count: reportCount }] =
    await Promise.all([
      supabase.from("locations").select("*", { count: "exact", head: true }),
      supabase.from("employees").select("*", { count: "exact", head: true }).eq("active", true),
      supabase
        .from("generated_reports")
        .select("*", { count: "exact", head: true })
        .is("superseded_at", null),
    ]);

  // Request-time cutoff for "stale" locations. Computed once here rather than
  // inline in the query: this is a server component, so Date.now() is a
  // legitimate request-time value, not a render-purity violation.
  // eslint-disable-next-line react-hooks/purity
  const staleCutoffIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data: staleLocations } = await supabase
    .from("locations")
    .select("id, name, last_data_uploaded_at")
    .eq("active", true)
    .or(`last_data_uploaded_at.is.null,last_data_uploaded_at.lt.${staleCutoffIso}`)
    .limit(5);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-slate-500 mt-1">Snapshot of platform activity.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Kpi label="Active locations" value={locationCount ?? 0} />
        <Kpi label="Active employees" value={employeeCount ?? 0} />
        <Kpi label="Current reports" value={reportCount ?? 0} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Locations needing attention</CardTitle>
          <CardDescription>Active locations with no upload in the last 48 hours.</CardDescription>
        </CardHeader>
        <CardContent>
          {!staleLocations || staleLocations.length === 0 ? (
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
