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
 *
 * §7b (epd_role spec 2026-08-26): deactivation is a person-level fact. When
 * the form carries deactivate_scope=all (the DEFAULT-CHECKED prompt for
 * multi-store people), the person's OTHER active rows — re-derived
 * server-side from seven_shifts_user_id, never trusted from the client —
 * are deactivated too, each behind its own epd_can_read_employee row gate.
 * A sibling outside the actor's purview is skipped with a warn line, never
 * silently written.
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

  // §7b person-level scope: only on DEACTIVATE, only when asked for. A
  // failed or skipped sibling is NEVER swallowed (Codex should-fix): the
  // operator confirmed "all stores", so a partial result surfaces as a
  // status_error banner naming what did not happen.
  const scopeAll = String(formData.get("deactivate_scope") ?? "") === "all";
  if (!nextActive && scopeAll) {
    const sibProblems: string[] = [];
    const { data: primary, error: primaryError } = await admin
      .from("employees")
      .select("seven_shifts_user_id")
      .eq("id", employeeId)
      .single();
    if (primaryError) sibProblems.push(`sibling lookup failed: ${primaryError.message}`);
    const sevenShiftsUserId = primary?.seven_shifts_user_id ?? null;
    if (sevenShiftsUserId !== null) {
      const { data: siblings, error: sibError } = await admin
        .from("employees")
        .select("id, location_id, employee_code")
        .eq("seven_shifts_user_id", sevenShiftsUserId)
        .eq("active", true)
        .neq("id", employeeId);
      if (sibError) sibProblems.push(`sibling read failed: ${sibError.message}`);
      for (const sib of siblings ?? []) {
        const sibAllowed = await canReadEmployee(
          supabase,
          String(sib.id),
          String(sib.location_id)
        );
        if (!sibAllowed) {
          console.warn("[employees] sibling deactivate skipped (scope)", {
            actor: user.id,
            role,
            employee_id: sib.id,
            location_id: sib.location_id,
          });
          sibProblems.push(`${sib.employee_code}: outside your scope, not deactivated`);
          continue;
        }
        const { error: sibUpdateError } = await admin
          .from("employees")
          .update({ active: false })
          .eq("id", sib.id)
          .eq("active", true);
        if (sibUpdateError) {
          console.error("[employees] sibling deactivate failed", {
            employee_id: sib.id,
            error: sibUpdateError.message,
          });
          sibProblems.push(`${sib.employee_code}: ${sibUpdateError.message}`);
          continue;
        }
        console.log("[employees] status toggled (person-level sibling)", {
          actor: user.id,
          role,
          employee_id: sib.id,
          location_id: sib.location_id,
          active: false,
        });
        revalidatePath(`/dashboard/employees/${sib.id}`);
      }
    }
    if (sibProblems.length > 0) {
      revalidatePath("/dashboard/employees");
      revalidatePath(`/dashboard/employees/${employeeId}`);
      redirect(
        `${returnTo}${returnTo.includes("?") ? "&" : "?"}status_error=${encodeURIComponent(
          `Deactivated at this store, but not everywhere: ${sibProblems.join("; ")}`
        )}`
      );
    }
  }

  revalidatePath("/dashboard/employees");
  revalidatePath(`/dashboard/employees/${employeeId}`);
  redirect(returnTo);
}
