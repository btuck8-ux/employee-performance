"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function createEmployeeAction(formData: FormData) {
  const location_id = String(formData.get("location_id") ?? "");
  const employee_name = String(formData.get("employee_name") ?? "").trim();
  const emailRaw = String(formData.get("email") ?? "").trim();
  const email = emailRaw ? emailRaw.toLowerCase() : null;
  const phoneRaw = String(formData.get("phone") ?? "").trim();
  const phone = phoneRaw || null;
  const hire_date = String(formData.get("hire_date") ?? "").trim() || null;
  const wageRaw = String(formData.get("wage") ?? "").trim();
  const wage = wageRaw ? Number(wageRaw) : null;
  if (!location_id || !employee_name) return;

  const supabase = await createClient();
  await supabase.from("employees").insert({
    location_id,
    employee_name,
    email,
    phone,
    hire_date,
    wage: wage !== null && !Number.isNaN(wage) ? wage : null,
    wage_pay_type: wage !== null && !Number.isNaN(wage) ? "Hourly" : null,
    active: true,
  });
  revalidatePath(`/dashboard/locations/${location_id}`);
}
