import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClientAction, deleteClientAction } from "./actions";

export default async function ClientsPage() {
  const supabase = await createClient();
  const { data: clients } = await supabase
    .from("clients")
    .select("id, name, created_at")
    .order("name");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
        <p className="text-sm text-slate-500 mt-1">
          Top-level grouping above locations. Each client can own one or more locations.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add client</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createClientAction} className="flex items-end gap-3 max-w-md">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="name">Client name</Label>
              <Input id="name" name="name" placeholder="e.g. Acme Corp" required />
            </div>
            <Button type="submit">Add</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All clients</CardTitle>
        </CardHeader>
        <CardContent>
          {!clients || clients.length === 0 ? (
            <p className="text-sm text-slate-500">No clients yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {clients.map((c) => (
                <li key={c.id} className="py-3 flex items-center justify-between">
                  <Link
                    href={`/dashboard/clients/${c.id}`}
                    className="font-medium hover:underline"
                  >
                    {c.name}
                  </Link>
                  <form action={deleteClientAction}>
                    <input type="hidden" name="id" value={c.id} />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      className="text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
