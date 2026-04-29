import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createLocationAction } from "./actions";

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("id, name")
    .eq("id", id)
    .single();
  if (!client) notFound();

  const { data: locations } = await supabase
    .from("locations")
    .select("id, name, active, last_data_uploaded_at")
    .eq("client_id", id)
    .order("name");

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-slate-500">
          <Link href="/dashboard/clients" className="hover:underline">
            ← All clients
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">{client.name}</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add location</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createLocationAction} className="flex items-end gap-3 max-w-md">
            <input type="hidden" name="client_id" value={client.id} />
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="loc_name">Location name</Label>
              <Input id="loc_name" name="name" placeholder="e.g. Downtown" required />
            </div>
            <Button type="submit">Add</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Locations</CardTitle>
        </CardHeader>
        <CardContent>
          {!locations || locations.length === 0 ? (
            <p className="text-sm text-slate-500">No locations yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {locations.map((loc) => (
                <li key={loc.id} className="py-3 flex items-center justify-between">
                  <Link
                    href={`/dashboard/locations/${loc.id}`}
                    className="font-medium hover:underline"
                  >
                    {loc.name}
                  </Link>
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
