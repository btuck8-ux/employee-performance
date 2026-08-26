"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function updateEmployeeAction(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const employee_name = String(formData.get("employee_name") ?? "").trim();
  const new_location_id = String(formData.get("location_id") ?? "");
  const emailRaw = String(formData.get("email") ?? "").trim();
  const email = emailRaw ? emailRaw.toLowerCase() : null;
  const phoneRaw = String(formData.get("phone") ?? "").trim();
  const phone = phoneRaw || null;
  const hire_date = String(formData.get("hire_date") ?? "").trim() || null;
  const wageRaw = String(formData.get("wage") ?? "").trim();
  const wage = wageRaw ? Number(wageRaw) : null;
  const wage_pay_type = String(formData.get("wage_pay_type") ?? "").trim() || null;
  const active = formData.get("active") === "1";
  // Mig 056: SA-set, ingest-immune non-puncher marker. This form and the
  // migration seed are its ONLY writers (pinned by test) — never the CSV
  // upload (which clobbers wage_pay_type, the reason this field exists) and
  // never derived from pay type or title. The sentinel guard means a POST
  // that never rendered the checkbox leaves the column untouched — absent
  // ≠ unchecked (Codex 2026-08-24).
  const ptcSubmitted = formData.get("punches_time_clock_present") === "1";
  const punches_time_clock = formData.get("punches_time_clock") === "1";
  // Effective date (§2a): the exclusion applies only to periods overlapping
  // [since, ∞) — pre-since history keeps scoring. Meaningless (forced null)
  // while the employee punches; blank while a non-puncher means "always".
  const ptcSinceRaw = String(formData.get("punches_time_clock_since") ?? "").trim();
  const punches_time_clock_since = punches_time_clock ? null : ptcSinceRaw || null;
  // Mig 057: GM classification — display/reporting dimension only, never a
  // metric input. Same writer discipline and sentinel guard as mig 056.
  const gmSubmitted = formData.get("is_general_manager_present") === "1";
  const is_general_manager = formData.get("is_general_manager") === "1";

  if (!id || !employee_name || !new_location_id) {
    redirect(`/dashboard/employees/${id}/edit?error=${encodeURIComponent("Name and location are required.")}`);
  }

  const supabase = await createClient();

  // Fetch the current location_id so we know whether this is a transfer
  // and can keep performance_records.location_id consistent — and the
  // current tier for the mig 071 lockstep below.
  const { data: current } = await supabase
    .from("employees")
    .select("location_id, epd_role")
    .eq("id", id)
    .single();

  const old_location_id = current?.location_id;
  const isTransfer = old_location_id && old_location_id !== new_location_id;

  // Mig 071 lockstep (Codex should-fix, epd_role sprint): the wire derives
  // is_general_manager from epd_role, so a GM change writes BOTH — flag for
  // the UI/partners mid-transition, tier for the truth — or they drift.
  // Only user↔manager rows sync: an area_admin+ row is never silently
  // re-tiered from a checkbox; that change is an operator decision on the
  // tier itself, so the GM toggle is skipped and logged instead.
  const tierSyncable =
    current?.epd_role === "user" ||
    current?.epd_role === "manager" ||
    current?.epd_role === "unclassified";
  if (gmSubmitted && !tierSyncable) {
    console.warn("[employees] GM toggle skipped — admin-tier row", {
      employee_id: id,
      epd_role: current?.epd_role ?? null,
    });
  }

  // ONE GM PER STORE (Tucker 2026-08-26, mig 075's wire-8 model; Codex
  // should-fix — the tier surface enforced this but this writer did not):
  // checking the box while the store already has another ACTIVE manager row
  // is rejected with the incumbent named. Demote the incumbent first.
  if (gmSubmitted && tierSyncable && is_general_manager) {
    const { data: incumbent } = await supabase
      .from("employees")
      .select("employee_code, employee_name")
      .eq("location_id", new_location_id)
      .eq("epd_role", "manager")
      .eq("active", true)
      .neq("id", id)
      .maybeSingle();
    if (incumbent) {
      redirect(
        `/dashboard/employees/${id}/edit?error=${encodeURIComponent(
          `This store already has a GM — ${incumbent.employee_name} (${incumbent.employee_code}). One GM per store; demote the incumbent first.`
        )}`
      );
    }
  }

  const { error } = await supabase
    .from("employees")
    .update({
      employee_name,
      location_id: new_location_id,
      email,
      phone,
      hire_date,
      wage: wage !== null && !Number.isNaN(wage) ? wage : null,
      wage_pay_type,
      active,
      ...(ptcSubmitted ? { punches_time_clock, punches_time_clock_since } : {}),
      ...(gmSubmitted && tierSyncable
        ? {
            is_general_manager,
            epd_role: is_general_manager ? "manager" : "user",
          }
        : {}),
    })
    .eq("id", id);

  if (error) {
    redirect(
      `/dashboard/employees/${id}/edit?error=${encodeURIComponent(error.message)}`
    );
  }

  // If transferring, sync performance_records.location_id so denormalized data stays consistent.
  if (isTransfer) {
    await supabase
      .from("performance_records")
      .update({ location_id: new_location_id })
      .eq("employee_id", id);
  }

  revalidatePath(`/dashboard/employees/${id}`);
  revalidatePath(`/dashboard/employees/${id}/edit`);
  revalidatePath("/dashboard/employees");
  revalidatePath(`/dashboard/locations/${new_location_id}`);
  if (old_location_id && isTransfer) {
    revalidatePath(`/dashboard/locations/${old_location_id}`);
  }

  redirect(`/dashboard/employees/${id}?saved=1`);
}
