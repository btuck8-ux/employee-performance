"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canReadEmployee, getSessionRole } from "@/lib/authz";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Deactivate / reactivate an employee (kickoff §5c + Tucker's §8-B ruling
 * 2026-08-14: EXTENDED TO MANAGERS, an explicit write-policy exception to the
 * writes-SA-only sprint rule for this one action).
 *
 * Authorization is two-layer and fails closed:
 *   1. tier gate — admin/manager tiers only (never user/null);
 *   2. row gate — epd_can_read_employee(emp, loc), the canonical scope
 *      predicate (SA all · RA territory · AA stores · manager own store).
 * The write itself rides the service role AFTER both checks, because the RLS
 * write policies remain SA-only — this action is the sanctioned exception
 * path, not a policy rewrite.
 *
 * Audit trail: one console line per toggle with actor/target ids (the
 * /api/reports/[id] pattern).
 */

const ALLOWED_TIERS = new Set([
  "system_admin",
  "regional_admin",
  "area_admin",
  "manager",
]);

export async function setEmployeeActiveAction(formData: FormData) {
  const employeeId = String(formData.get("employee_id") ?? "");
  const locationId = String(formData.get("location_id") ?? "");
  const nextActive = String(formData.get("next_active") ?? "") === "1";
  // Same-origin paths only — a caller-supplied absolute/protocol-relative
  // URL must never reach redirect() (Codex 2026-08-14: open-redirect risk).
  const rawReturnTo = String(formData.get("return_to") ?? "");
  const returnTo =
    rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//")
      ? rawReturnTo
      : "/dashboard/employees";

  const { supabase, user, role } = await getSessionRole();
  if (!user || !role || !ALLOWED_TIERS.has(role)) {
    console.warn("[employees] status toggle denied (tier)", {
      user_id: user?.id ?? null,
      role,
      employee_id: employeeId,
    });
    redirect("/dashboard");
  }
  if (!employeeId || !locationId) redirect(returnTo);

  const allowed = await canReadEmployee(supabase, employeeId, locationId);
  if (!allowed) {
    console.warn("[employees] status toggle denied (scope)", {
      user_id: user.id,
      role,
      employee_id: employeeId,
      location_id: locationId,
    });
    redirect("/dashboard");
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("employees")
    .update({ active: nextActive })
    .eq("id", employeeId)
    .eq("location_id", locationId);
  if (error) {
    console.error("[employees] status toggle failed", {
      employee_id: employeeId,
      error: error.message,
    });
    redirect(
      `${returnTo}${returnTo.includes("?") ? "&" : "?"}status_error=${encodeURIComponent(error.message)}`
    );
  }

  console.log("[employees] status toggled", {
    actor: user.id,
    role,
    employee_id: employeeId,
    location_id: locationId,
    active: nextActive,
  });

  revalidatePath("/dashboard/employees");
  revalidatePath(`/dashboard/employees/${employeeId}`);
  redirect(returnTo);
}
