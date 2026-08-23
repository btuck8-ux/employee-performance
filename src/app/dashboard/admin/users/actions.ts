"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Users surface actions (2026-08-23 sprint §4-D). Generalizes the
 * clients-page invite (invite-actions.ts) to all five roles.
 *
 * SA-only, re-checked server-side in every action. The privileged work rides
 * the service-role admin client — the invite-actions.ts precedent: auth.admin
 * needs it, and this action IS the SA surface the user_roles policies point
 * at.
 *
 * NO CREDENTIAL FIELDS, ANYWHERE (§4-D3, non-negotiable): the flow is Supabase Auth
 * invitations only — the invitee sets their own credential on first
 * sign-in. This module must never accept, store, transmit, log, or set one;
 * a test greps for the word and fails on a match.
 *
 * Ordering fix over the old invite path (§4-D8a): the target is resolved and
 * their existing role checked BEFORE any invite email is sent — the old path
 * emailed first and refused after. The existing-role lookup keeps
 * .maybeSingle(): a target holding two user_roles rows errors and lands on
 * the fail-closed path rather than the "already holds a role" message —
 * fail-closed is the acceptable behaviour, kept deliberately.
 *
 * Role-change doctrine (§4-D7): this surface REFUSES to touch an account
 * that already holds any role (silently downgrading a system_admin would be
 * a catastrophe — invite-actions.ts doctrine, kept). Revoke-then-re-grant is
 * the two-step path, and the LAST system_admin can never be revoked.
 * In-place role editing is a Tucker decision point, not built.
 */

export type GrantableRole =
  | "system_admin"
  | "regional_admin"
  | "area_admin"
  | "manager"
  | "user";

const GRANTABLE_ROLES: GrantableRole[] = [
  "system_admin",
  "regional_admin",
  "area_admin",
  "manager",
  "user",
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BACK = "/dashboard/admin/users";

function back(params: Record<string, string>): never {
  const qs = new URLSearchParams(params).toString();
  redirect(`${BACK}?${qs}`);
}

interface RoleScope {
  territory_id: string | null;
  location_ids: string[] | null;
  location_id: string | null;
  employee_id: string | null;
}

/**
 * Build the exact scope shape the user_roles_scope_shape CHECK expects
 * (§4-D5, verified live 2026-08-23). Returns an error message instead of a
 * scope when the form's combination is invalid — clearer than letting the
 * CHECK reject the insert.
 */
function buildScope(
  role: GrantableRole,
  form: {
    territoryId: string;
    locationIds: string[];
    locationId: string;
    employeeId: string;
  }
): { scope: RoleScope } | { error: string } {
  const empty: RoleScope = {
    territory_id: null,
    location_ids: null,
    location_id: null,
    employee_id: null,
  };
  switch (role) {
    case "system_admin":
      return { scope: empty };
    case "regional_admin":
      if (!form.territoryId)
        return { error: "Regional Admin needs a territory." };
      return { scope: { ...empty, territory_id: form.territoryId } };
    case "area_admin":
      if (form.locationIds.length === 0)
        return { error: "Area Admin needs at least one location." };
      return { scope: { ...empty, location_ids: form.locationIds } };
    case "manager":
      if (!form.locationId) return { error: "Manager needs a location." };
      return { scope: { ...empty, location_id: form.locationId } };
    case "user":
      return {
        scope: { ...empty, employee_id: form.employeeId || null },
      };
  }
}

/** Paged auth.users lookup by email — the invite-actions.ts fallback shape,
 * run as a PRE-check here (§4-D8a). Throws on a page error: an unverifiable
 * directory must fail closed, never fall through to an invite. */
async function findAuthUserByEmail(
  admin: ReturnType<typeof createAdminClient>,
  email: string
): Promise<{ id: string } | null> {
  for (let page = 1; page <= 10; page += 1) {
    const { data: usersPage, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw new Error(`listUsers page ${page}: ${error.message}`);
    const hit =
      usersPage.users.find((u) => (u.email ?? "").toLowerCase() === email) ??
      null;
    if (hit) return { id: hit.id };
    if (usersPage.users.length < 1000) return null;
  }
  return null;
}

export async function inviteUserAction(formData: FormData) {
  const { user, role } = await getSessionRole();
  if (!user || role !== "system_admin") {
    console.warn("[users] invite denied (tier)", {
      user_id: user?.id ?? null,
      role,
    });
    redirect("/dashboard");
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const emailConfirm = String(formData.get("email_confirm") ?? "")
    .trim()
    .toLowerCase();
  const targetRole = String(formData.get("role") ?? "") as GrantableRole;
  const territoryId = String(formData.get("territory_id") ?? "").trim();
  const locationId = String(formData.get("location_id") ?? "").trim();
  const employeeId = String(formData.get("employee_id") ?? "").trim();
  const locationIds = formData
    .getAll("location_ids")
    .map((v) => String(v).trim())
    .filter(Boolean);

  if (!EMAIL_RE.test(email)) back({ error: "Enter a valid email address." });
  if (email !== emailConfirm) back({ error: "Email addresses do not match." });
  if (!GRANTABLE_ROLES.includes(targetRole))
    back({ error: "Pick a role to grant." });

  const built = buildScope(targetRole, {
    territoryId,
    locationIds,
    locationId,
    employeeId,
  });
  if ("error" in built) back({ error: built.error });
  const scope = built.scope;

  const admin = createAdminClient();

  // §4-D8a: resolve BEFORE inviting — an account that will be refused must
  // never receive an invite email first.
  let existing: { id: string } | null = null;
  try {
    existing = await findAuthUserByEmail(admin, email);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[users] directory lookup failed pre-invite", {
      actor: user.id,
      error: message,
    });
    back({
      error: `Could not verify whether ${email} already has an account (${message}) — nothing sent, nothing granted.`,
    });
  }

  if (existing) {
    const { data: existingRole, error: roleLookupErr } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", existing.id)
      .maybeSingle();
    if (roleLookupErr) {
      // Fail CLOSED (Codex finding 2026-08-14, carried forward): a failed
      // lookup must never fall through to a grant.
      console.error("[users] role lookup failed pre-grant", {
        actor: user.id,
        target: existing.id,
        error: roleLookupErr.message,
      });
      back({
        error: `Could not verify the account's existing role (${roleLookupErr.message}) — no grant made.`,
      });
    }
    if (existingRole) {
      back({
        error: `${email} already holds the ${existingRole.role} role — revoke it first if this is intentional (roles are never changed in place here).`,
      });
    }
  }

  let targetUserId: string;
  let invitedNewAccount: boolean;
  if (existing) {
    targetUserId = existing.id;
    invitedNewAccount = false;
  } else {
    const { data: invited, error: inviteErr } =
      await admin.auth.admin.inviteUserByEmail(email);
    if (inviteErr || !invited?.user) {
      console.warn("[users] invite failed", {
        actor: user.id,
        error: inviteErr?.message ?? "no user returned",
      });
      back({
        error: `Invite failed: ${inviteErr?.message ?? "no user returned"}`,
      });
    }
    targetUserId = invited.user.id;
    invitedNewAccount = true;
  }

  const { error: grantErr } = await admin.from("user_roles").insert({
    user_id: targetUserId,
    role: targetRole,
    ...scope,
    granted_by: user.id,
  });
  if (grantErr) {
    console.error("[users] role grant failed", {
      actor: user.id,
      target: targetUserId,
      role: targetRole,
      error: grantErr.message,
    });
    back({
      error: invitedNewAccount
        ? `Invite sent, but the role grant failed: ${grantErr.message}. Re-run the invite for this address to retry the grant.`
        : `Role grant failed: ${grantErr.message}`,
    });
  }

  console.log("[users] role granted", {
    actor: user.id,
    target: targetUserId,
    email,
    role: targetRole,
    territory_id: scope.territory_id,
    location_ids: scope.location_ids,
    location_id: scope.location_id,
    employee_id: scope.employee_id,
    invited_new_account: invitedNewAccount,
  });

  revalidatePath(BACK);
  back({
    ok: invitedNewAccount
      ? `Invite sent to ${email}; ${targetRole} staged for first sign-in.`
      : `${email} already had an account — granted ${targetRole} (no invite email sent).`,
  });
}

export async function revokeRoleAction(formData: FormData) {
  const { user, role } = await getSessionRole();
  if (!user || role !== "system_admin") {
    console.warn("[users] revoke denied (tier)", {
      user_id: user?.id ?? null,
      role,
    });
    redirect("/dashboard");
  }

  const targetUserId = String(formData.get("user_id") ?? "").trim();
  if (!targetUserId) back({ error: "No account selected." });

  const admin = createAdminClient();

  const { data: row, error: lookupErr } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (lookupErr) {
    console.error("[users] revoke lookup failed", {
      actor: user.id,
      target: targetUserId,
      error: lookupErr.message,
    });
    back({ error: `Could not verify the role (${lookupErr.message}) — nothing revoked.` });
  }
  if (!row) back({ error: "That account holds no role — nothing to revoke." });

  // Never let the last system_admin be revoked (§4-D7) — the lockout is
  // unrecoverable from the app.
  if (row.role === "system_admin") {
    const { count, error: countErr } = await admin
      .from("user_roles")
      .select("user_id", { count: "exact", head: true })
      .eq("role", "system_admin");
    if (countErr || count === null) {
      console.error("[users] SA count failed pre-revoke", {
        actor: user.id,
        error: countErr?.message ?? "null count",
      });
      back({
        error: "Could not verify how many system admins remain — nothing revoked.",
      });
    }
    if (count <= 1) {
      back({
        error:
          "Refusing to revoke the last system_admin — the dashboard would have no administrator.",
      });
    }
  }

  const { error: delErr } = await admin
    .from("user_roles")
    .delete()
    .eq("user_id", targetUserId)
    .eq("role", row.role);
  if (delErr) back({ error: `Revoke failed: ${delErr.message}` });

  // Codex finding 4 (2026-08-23): the count-then-delete above is not atomic —
  // two concurrent revokes of the two remaining SAs could both pass the
  // guard. PostgREST can't express a subquery-guarded delete and an RPC
  // would be another migration, so the race closes with a post-delete
  // verify: if zero system_admins remain, re-grant the row just removed and
  // refuse. (SA scope columns are all null by the CHECK, so the re-insert
  // is complete.)
  if (row.role === "system_admin") {
    const { count: remaining, error: verifyErr } = await admin
      .from("user_roles")
      .select("user_id", { count: "exact", head: true })
      .eq("role", "system_admin");
    if (verifyErr || remaining === null || remaining < 1) {
      const { error: restoreErr } = await admin.from("user_roles").insert({
        user_id: targetUserId,
        role: "system_admin",
        granted_by: user.id,
      });
      console.error("[users] last-SA revoke race caught post-delete", {
        actor: user.id,
        target: targetUserId,
        verify_error: verifyErr?.message ?? null,
        restore_error: restoreErr?.message ?? null,
      });
      back({
        error: restoreErr
          ? `Revoke aborted: the last system_admin was about to be removed and the restore ALSO failed (${restoreErr.message}) — fix user_roles by SQL now.`
          : "Revoke aborted: a concurrent revoke would have removed the last system_admin — the role was restored.",
      });
    }
  }

  console.log("[users] role revoked", {
    actor: user.id,
    target: targetUserId,
    role: row.role,
  });

  revalidatePath(BACK);
  back({ ok: `Revoked ${row.role}. Re-grant from the invite form if needed.` });
}
