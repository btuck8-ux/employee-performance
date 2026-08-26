"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Inline tier setter for the unclassified queue (CSU memo §6, Tucker's
 * requirement: "the UI prompts an admin to take a look so it can be
 * classified as soon as possible").
 *
 * Writes the tier a HUMAN chose — the whole point of the unclassified
 * state is that nothing here is ever derived or defaulted. Two invariants
 * ride the write:
 *   * GM LOCKSTEP (mig 071 transition doctrine): is_general_manager =
 *     (tier == 'manager'), per row — the tier is a PER-STORE fact.
 *   * ONE GM PER STORE (Tucker 2026-08-26): choosing manager while the
 *     store has another ACTIVE manager row is rejected with the
 *     incumbent named — a real GM change demotes the incumbent first.
 *
 * SA-only surface; the write rides the service role after the check (047
 * doctrine).
 */

const QUEUE_PATH = "/dashboard/admin/unclassified-tiers";

const ASSIGNABLE_TIERS = new Set([
  "user",
  "manager",
  "area_admin",
  "regional_admin",
  "system_admin",
]);

export async function setEmployeeTierAction(formData: FormData) {
  const employeeId = String(formData.get("employee_id") ?? "");
  const tier = String(formData.get("tier") ?? "");

  const { user, role } = await getSessionRole();
  if (!user || role !== "system_admin") redirect("/dashboard");
  if (!employeeId || !ASSIGNABLE_TIERS.has(tier)) {
    redirect(`${QUEUE_PATH}?error=${encodeURIComponent("Pick a tier — unclassified is the state you are leaving.")}`);
  }

  const admin = createAdminClient();
  const { data: emp, error: empError } = await admin
    .from("employees")
    .select("id, employee_code, employee_name, location_id, locations(name)")
    .eq("id", employeeId)
    .maybeSingle();
  if (empError || !emp) {
    redirect(`${QUEUE_PATH}?error=${encodeURIComponent(empError?.message ?? "Employee not found")}`);
  }

  if (tier === "manager") {
    const { data: incumbent, error: gmError } = await admin
      .from("employees")
      .select("employee_code, employee_name")
      .eq("location_id", emp.location_id)
      .eq("epd_role", "manager")
      .eq("active", true)
      .neq("id", employeeId)
      .maybeSingle();
    if (gmError) {
      redirect(`${QUEUE_PATH}?error=${encodeURIComponent(`incumbent check: ${gmError.message}`)}`);
    }
    if (incumbent) {
      redirect(
        `${QUEUE_PATH}?error=${encodeURIComponent(
          `${(emp.locations as { name?: string } | null)?.name ?? "This store"} already has a GM — ${incumbent.employee_name} (${incumbent.employee_code}). One GM per store; demote the incumbent first.`
        )}`
      );
    }
  }

  const { error: updateError } = await admin
    .from("employees")
    .update({
      epd_role: tier,
      // Lockstep: the wire derives from the tier; the stored flag follows
      // until its post-partner-confirmation drop.
      is_general_manager: tier === "manager",
    })
    .eq("id", employeeId);
  if (updateError) {
    redirect(`${QUEUE_PATH}?error=${encodeURIComponent(updateError.message)}`);
  }

  console.log("[unclassified-tiers] tier set", {
    actor: user.id,
    employee_id: employeeId,
    employee_code: emp.employee_code,
    tier,
  });

  revalidatePath(QUEUE_PATH);
  revalidatePath("/dashboard/employees");
  revalidatePath(`/dashboard/employees/${employeeId}`);
  revalidatePath("/dashboard/admin");
  redirect(
    `${QUEUE_PATH}?classified=1&name=${encodeURIComponent(emp.employee_name)}&tier=${encodeURIComponent(tier)}`
  );
}
