"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function createEmployeeAction(formData: FormData) {
  const location_id = String(formData.get("location_id") ?? "");
  const employee_name = String(formData.get("employee_name") ?? "").trim();
  const external_id = String(formData.get("external_id") ?? "").trim() || null;
  const hire_date = String(formData.get("hire_date") ?? "").trim() || null;
  if (!location_id || !employee_name) return;

  const supabase = await createClient();
  await supabase.from("employees").insert({
    location_id,
    employee_name,
    external_id,
    hire_date,
  });
  revalidatePath(`/dashboard/locations/${location_id}`);
}
