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
  // never derived from pay type or title.
  const punches_time_clock = formData.get("punches_time_clock") === "1";

  if (!id || !employee_name || !new_location_id) {
    redirect(`/dashboard/employees/${id}/edit?error=${encodeURIComponent("Name and location are required.")}`);
  }

  const supabase = await createClient();

  // Fetch the current location_id so we know whether this is a transfer
  // and can keep performance_records.location_id consistent.
  const { data: current } = await supabase
    .from("employees")
    .select("location_id")
    .eq("id", id)
    .single();

  const old_location_id = current?.location_id;
  const isTransfer = old_location_id && old_location_id !== new_location_id;

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
      punches_time_clock,
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
