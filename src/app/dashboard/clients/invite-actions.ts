"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * RA invite + revoke for client groups (kickoff-ui-rbac-c-brand-2026-08-14.md §4).
 *
 * SA-only, re-checked here server-side (the page render gate alone would not
 * stop a hand-crafted POST — same doctrine as admin/scoring). The privileged
 * work rides the service-role admin client: auth.admin.inviteUserByEmail
 * requires it, and user_roles writes bypass RLS on it deliberately (writes
 * are SA-only at the policy layer; this action IS the SA surface).
 *
 * Grant model (locked 2026-08-14): a client's managing admins are user_roles
 * rows with role='regional_admin' + territory_id of the client's territory
 * (1:1 client↔territory today). N admins per client is expected. If a client
 * ever maps to zero or multiple territories this action refuses — that fork
 * is a Tucker decision point (the 1:1 mapping may not stay 1:1), never an
 * implicit pick here.
 *
 * Audit trail: one console line per invite/grant/revoke with actor + target
 * ids (the /api/reports/[id] scope-denial pattern — server-side Vercel logs,
 * nothing leaked to the caller).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function back(clientId: string, params: Record<string, string>): never {
  const qs = new URLSearchParams(params).toString();
  redirect(`/dashboard/clients?${qs}#client-${clientId}`);
}

/** Resolve the client's single territory; null when the 1:1 mapping doesn't hold. */
async function territoryForClient(
  admin: ReturnType<typeof createAdminClient>,
  clientId: string
): Promise<string | null> {
  const { data, error } = await admin
    .from("locations")
    .select("territory_id")
    .eq("client_id", clientId)
    .not("territory_id", "is", null);
  if (error) return null;
  const distinct = Array.from(new Set((data ?? []).map((r) => r.territory_id as string)));
  return distinct.length === 1 ? distinct[0] : null;
}

export async function inviteClientAdminAction(formData: FormData) {
  const clientId = String(formData.get("client_id") ?? "");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const emailConfirm = String(formData.get("email_confirm") ?? "").trim().toLowerCase();

  const { user, role } = await getSessionRole();
  if (!user || role !== "system_admin") {
    console.warn("[clients] invite denied", { user_id: user?.id ?? null, role });
    redirect("/dashboard");
  }
  if (!clientId) redirect("/dashboard/clients");
  if (!EMAIL_RE.test(email)) {
    back(clientId, { invite_error: "Enter a valid email address.", invite_client: clientId });
  }
  if (email !== emailConfirm) {
    back(clientId, { invite_error: "Email addresses do not match.", invite_client: clientId });
  }

  const admin = createAdminClient();

  const territoryId = await territoryForClient(admin, clientId);
  if (!territoryId) {
    // 0 or >1 territories under this client — the deliberate 1:1 assumption
    // doesn't hold; stop rather than guess (Tucker decision point).
    back(clientId, {
      invite_error:
        "This client does not map to exactly one territory — cannot infer the admin scope. Flag to Tucker.",
      invite_client: clientId,
    });
  }

  // Invite (or find) the auth user.
  let targetUserId: string | null = null;
  let grantedExisting = false;
  const { data: invited, error: inviteErr } =
    await admin.auth.admin.inviteUserByEmail(email);
  if (inviteErr) {
    // Existing account (already signed up / already invited): grant the role
    // to the existing user instead of failing — no second email is sent.
    const { data: usersPage, error: listErr } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    const existing = listErr
      ? null
      : usersPage.users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (!existing) {
      console.warn("[clients] invite failed", {
        actor: user.id,
        client_id: clientId,
        error: inviteErr.message,
      });
      back(clientId, {
        invite_error: `Invite failed: ${inviteErr.message}`,
        invite_client: clientId,
      });
    }
    targetUserId = existing!.id;
    grantedExisting = true;
  } else {
    targetUserId = invited.user.id;
  }

  // Refuse to touch an account that already holds ANY role — changing or
  // stacking roles is not this surface's job (and silently downgrading a
  // system_admin would be a catastrophe).
  const { data: existingRole } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", targetUserId!)
    .maybeSingle();
  if (existingRole) {
    back(clientId, {
      invite_error: `${email} already holds the ${existingRole.role} role — revoke it first if this is intentional.`,
      invite_client: clientId,
    });
  }

  const { error: roleErr } = await admin.from("user_roles").insert({
    user_id: targetUserId!,
    role: "regional_admin",
    territory_id: territoryId,
    granted_by: user.id,
  });
  if (roleErr) {
    console.error("[clients] role grant failed after invite", {
      actor: user.id,
      target: targetUserId,
      client_id: clientId,
      error: roleErr.message,
    });
    back(clientId, {
      invite_error: `Invited, but the role grant failed: ${roleErr.message}. Re-run the invite to retry the grant.`,
      invite_client: clientId,
    });
  }

  console.log("[clients] regional_admin granted", {
    actor: user.id,
    target: targetUserId,
    email,
    client_id: clientId,
    territory_id: territoryId,
    invited_new_account: !grantedExisting,
  });

  revalidatePath("/dashboard/clients");
  back(clientId, {
    invite_ok: grantedExisting
      ? `${email} already had an account — granted Regional Admin (no invite email sent).`
      : `Invite sent to ${email}; Regional Admin role staged for first sign-in.`,
    invite_client: clientId,
  });
}

export async function revokeClientAdminAction(formData: FormData) {
  const clientId = String(formData.get("client_id") ?? "");
  const targetUserId = String(formData.get("user_id") ?? "");

  const { user, role } = await getSessionRole();
  if (!user || role !== "system_admin") {
    console.warn("[clients] revoke denied", { user_id: user?.id ?? null, role });
    redirect("/dashboard");
  }
  if (!clientId || !targetUserId) redirect("/dashboard/clients");

  const admin = createAdminClient();

  // Only regional_admin rows are revocable from this surface.
  const { data: row } = await admin
    .from("user_roles")
    .select("role, territory_id")
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (!row || row.role !== "regional_admin") {
    back(clientId, {
      invite_error: "That account no longer holds a Regional Admin role.",
      invite_client: clientId,
    });
  }

  const { error: delErr } = await admin
    .from("user_roles")
    .delete()
    .eq("user_id", targetUserId)
    .eq("role", "regional_admin");
  if (delErr) {
    back(clientId, {
      invite_error: `Revoke failed: ${delErr.message}`,
      invite_client: clientId,
    });
  }

  console.log("[clients] regional_admin revoked", {
    actor: user.id,
    target: targetUserId,
    client_id: clientId,
    territory_id: row!.territory_id,
  });

  revalidatePath("/dashboard/clients");
  back(clientId, {
    invite_ok: "Regional Admin access revoked.",
    invite_client: clientId,
  });
}
