"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * §7c (epd_role spec 2026-08-26) — the candidate queue's two human acts.
 * The sweep only NOTIFIES (mig 072); everything that touches
 * employees.active happens here, behind an explicit SA decision:
 *
 *   dismiss    → status='dismissed'; the person was never departed.
 *   deactivate → employees.active=false for the candidate's row AND every
 *                active sibling row (a departure is a person-level fact,
 *                §7b); any sibling's own open candidate resolves with it;
 *                status='actioned'.
 *
 * SA-only: the queue is an admin surface (matching triage/crosswalk); the
 * writes ride the service role AFTER the check (047 write doctrine).
 * resolved_by records the deciding login (public.users, the FK-vestige
 * table the signup trigger fills).
 */

const QUEUE_PATH = "/dashboard/admin/departure-candidates";

export async function resolveDepartureCandidateAction(formData: FormData) {
  const candidateId = String(formData.get("candidate_id") ?? "");
  const resolution = String(formData.get("resolution") ?? "");

  const { user, role } = await getSessionRole();
  if (!user || role !== "system_admin") redirect("/dashboard");
  if (!candidateId || !["dismissed", "actioned"].includes(resolution)) {
    redirect(QUEUE_PATH);
  }

  const admin = createAdminClient();
  const { data: candidate, error: candError } = await admin
    .from("departure_candidates")
    .select("id, status, employee_id, employees(id, employee_code, employee_name, seven_shifts_user_id)")
    .eq("id", candidateId)
    .maybeSingle();
  if (candError || !candidate) {
    redirect(`${QUEUE_PATH}?error=${encodeURIComponent(candError?.message ?? "Candidate not found")}`);
  }
  if (candidate.status !== "open") {
    redirect(`${QUEUE_PATH}?already=1`);
  }

  const emp = candidate.employees as unknown as {
    id: string;
    employee_code: string;
    employee_name: string;
    seven_shifts_user_id: number | string | null;
  } | null;

  const resolvedEmployeeIds: string[] = [String(candidate.employee_id)];

  if (resolution === "actioned") {
    // Person-level target set: the candidate's row + active siblings.
    const targetIds = new Set<string>([String(candidate.employee_id)]);
    const sevenShiftsUserId =
      emp?.seven_shifts_user_id === null || emp?.seven_shifts_user_id === undefined
        ? null
        : Number(emp.seven_shifts_user_id);
    if (sevenShiftsUserId !== null && Number.isSafeInteger(sevenShiftsUserId)) {
      const { data: siblings, error: sibError } = await admin
        .from("employees")
        .select("id")
        .eq("seven_shifts_user_id", sevenShiftsUserId)
        .eq("active", true);
      if (sibError) {
        redirect(`${QUEUE_PATH}?error=${encodeURIComponent(`sibling read: ${sibError.message}`)}`);
      }
      for (const s of siblings ?? []) targetIds.add(String(s.id));
    }

    const { error: deactError } = await admin
      .from("employees")
      .update({ active: false })
      .in("id", [...targetIds]);
    if (deactError) {
      redirect(`${QUEUE_PATH}?error=${encodeURIComponent(`deactivate: ${deactError.message}`)}`);
    }
    resolvedEmployeeIds.push(...targetIds);
    console.log("[departure-queue] deactivated person-level", {
      actor: user.id,
      candidate_id: candidateId,
      employee_code: emp?.employee_code ?? null,
      rows: [...targetIds],
    });
  }

  // Resolve the clicked candidate — and, on deactivate, any other open
  // candidate covering a row we just deactivated (same person, other store).
  const { error: resolveError } = await admin
    .from("departure_candidates")
    .update({
      status: resolution,
      resolved_at: new Date().toISOString(),
      resolved_by: user.id,
    })
    .eq("status", "open")
    .in("employee_id", [...new Set(resolvedEmployeeIds)]);
  if (resolveError) {
    redirect(`${QUEUE_PATH}?error=${encodeURIComponent(`resolve: ${resolveError.message}`)}`);
  }

  console.log("[departure-queue] candidate resolved", {
    actor: user.id,
    candidate_id: candidateId,
    resolution,
    employee_code: emp?.employee_code ?? null,
  });

  revalidatePath(QUEUE_PATH);
  revalidatePath("/dashboard/employees");
  redirect(
    `${QUEUE_PATH}?${resolution === "actioned" ? "actioned" : "dismissed"}=1&name=${encodeURIComponent(emp?.employee_name ?? "")}`
  );
}

/** SA "run sweep now" lever — same RPC the CRON_SECRET POST rides. */
export async function runDepartureSweepAction() {
  const { user, role } = await getSessionRole();
  if (!user || role !== "system_admin") redirect("/dashboard");

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("sweep_departure_candidates");
  if (error) {
    redirect(`${QUEUE_PATH}?error=${encodeURIComponent(`sweep: ${error.message}`)}`);
  }
  console.log("[departure-queue] sweep run", {
    actor: user.id,
    newly_surfaced: Number(data ?? 0),
  });
  revalidatePath(QUEUE_PATH);
  redirect(`${QUEUE_PATH}?swept=${Number(data ?? 0)}`);
}
