import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function LocationsPage() {
  const supabase = await createClient();
  const { data: locations } = await supabase
    .from("locations")
    .select("id, name, active, last_data_uploaded_at, clients(name)")
    .order("name");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Locations</h1>
        <p className="text-sm text-slate-500 mt-1">
          All locations across all clients. Add new locations from a client's detail page.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All locations</CardTitle>
        </CardHeader>
        <CardContent>
          {!locations || locations.length === 0 ? (
            <p className="text-sm text-slate-500">No locations yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {locations.map((loc) => (
                <li key={loc.id} className="py-3 flex items-center justify-between">
                  <div>
                    <Link
                      href={`/dashboard/locations/${loc.id}`}
                      className="font-medium hover:underline"
                    >
                      {loc.name}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {(loc.clients as unknown as { name: string } | null)?.name ?? "No client"}
                    </p>
                  </div>
                  <span className="text-xs text-slate-500">
                    {loc.last_data_uploaded_at
                      ? `Last upload: ${new Date(loc.last_data_uploaded_at).toLocaleDateString()}`
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
