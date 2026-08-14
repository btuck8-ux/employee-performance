import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClientAction, deleteClientAction } from "./actions";
import { inviteClientAdminAction, revokeClientAdminAction } from "./invite-actions";

/**
 * Clients = the client-group management surface (kickoff §4): per client, its
 * stores, its managing Regional Admins (N ≥ 0), and the SA-only invite tool.
 * SA-only page — nav hides it for other tiers, but the redirect here is the
 * real gate (nav hiding is UX, not security), and the invite/revoke actions
 * re-check independently.
 */

interface ClientAdminRow {
  client_id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  invited_pending: boolean;
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const { role, supabase } = await getSessionRole();
  if (role !== "system_admin") redirect("/dashboard");

  const [{ data: clients }, { data: locations }, adminsRes] = await Promise.all([
    supabase.from("clients").select("id, name, created_at").order("name"),
    supabase
      .from("locations")
      .select("id, name, location_code, active, client_id")
      .order("name"),
    supabase.rpc("epd_list_client_admins"),
  ]);

  const admins = (adminsRes.data ?? []) as ClientAdminRow[];
  if (adminsRes.error) {
    console.error("[clients] epd_list_client_admins rpc failed", {
      message: adminsRes.error.message,
    });
  }

  const locationsByClient = new Map<string, NonNullable<typeof locations>>();
  for (const loc of locations ?? []) {
    if (!loc.client_id) continue;
    const list = locationsByClient.get(loc.client_id) ?? [];
    list.push(loc);
    locationsByClient.set(loc.client_id, list);
  }
  const adminsByClient = new Map<string, ClientAdminRow[]>();
  for (const a of admins) {
    const list = adminsByClient.get(a.client_id) ?? [];
    list.push(a);
    adminsByClient.set(a.client_id, list);
  }

  const inviteError = typeof search.invite_error === "string" ? search.invite_error : null;
  const inviteOk = typeof search.invite_ok === "string" ? search.invite_ok : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
        <p className="text-sm text-slate-500 mt-1">
          Client groups: their stores and managing admins. Regional Admins see
          every store in their group.
        </p>
      </div>

      {inviteError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {inviteError}
        </div>
      )}
      {inviteOk && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {inviteOk}
        </div>
      )}

      {(!clients || clients.length === 0) && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-slate-500">No clients yet.</p>
          </CardContent>
        </Card>
      )}

      {(clients ?? []).map((c) => {
        const stores = locationsByClient.get(c.id) ?? [];
        const clientAdmins = adminsByClient.get(c.id) ?? [];
        return (
          <Card key={c.id} id={`client-${c.id}`}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle>
                <Link href={`/dashboard/clients/${c.id}`} className="hover:underline">
                  {c.name}
                </Link>
              </CardTitle>
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
            </CardHeader>
            <CardContent className="space-y-5">
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
                  Stores
                </h3>
                {stores.length === 0 ? (
                  <p className="text-sm text-slate-500">No locations under this client.</p>
                ) : (
                  <ul className="grid gap-1.5 sm:grid-cols-2">
                    {stores.map((loc) => (
                      <li key={loc.id} className="flex items-center gap-2 text-sm">
                        <Link
                          href={`/dashboard/locations/${loc.id}`}
                          className="font-medium hover:underline"
                        >
                          {loc.name}
                        </Link>
                        {loc.location_code && (
                          <Badge>{loc.location_code}</Badge>
                        )}
                        {loc.active === false && (
                          <Badge tone="muted">inactive</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
                  Managing admins
                </h3>
                {clientAdmins.length === 0 ? (
                  <p className="text-sm text-slate-400">—</p>
                ) : (
                  <ul className="space-y-1.5">
                    {clientAdmins.map((a) => (
                      <li key={a.user_id} className="flex items-center gap-2 text-sm">
                        <span className="font-medium">
                          {a.display_name ?? a.email}
                        </span>
                        {a.display_name && (
                          <span className="text-slate-500">{a.email}</span>
                        )}
                        {a.invited_pending && (
                          <Badge className="bg-amber-100 text-amber-800">invite pending</Badge>
                        )}
                        <form action={revokeClientAdminAction}>
                          <input type="hidden" name="client_id" value={c.id} />
                          <input type="hidden" name="user_id" value={a.user_id} />
                          <Button
                            type="submit"
                            variant="ghost"
                            size="sm"
                            className="text-red-600 hover:bg-red-50"
                          >
                            Revoke
                          </Button>
                        </form>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
                  Invite an admin
                </h3>
                <form
                  action={inviteClientAdminAction}
                  className="flex flex-wrap items-end gap-3 max-w-2xl"
                >
                  <input type="hidden" name="client_id" value={c.id} />
                  <div className="flex-1 min-w-48 space-y-1.5">
                    <Label htmlFor={`invite-email-${c.id}`}>Email</Label>
                    <Input
                      id={`invite-email-${c.id}`}
                      name="email"
                      type="email"
                      placeholder="admin@example.com"
                      required
                    />
                  </div>
                  <div className="flex-1 min-w-48 space-y-1.5">
                    <Label htmlFor={`invite-email-confirm-${c.id}`}>Confirm email</Label>
                    <Input
                      id={`invite-email-confirm-${c.id}`}
                      name="email_confirm"
                      type="email"
                      placeholder="admin@example.com"
                      required
                    />
                  </div>
                  <Button type="submit">Invite as Regional Admin</Button>
                </form>
                <p className="text-xs text-slate-500 mt-1.5">
                  Sends a Supabase invite email and stages Regional Admin access
                  to every store in this group.
                </p>
              </div>
            </CardContent>
          </Card>
        );
      })}

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
    </div>
  );
}
