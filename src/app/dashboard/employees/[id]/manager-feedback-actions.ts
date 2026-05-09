"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Save manager feedback for a single (employee, quarter) performance_record.
 * The DB-side trigger on `performance_records.manager_feedback` flips
 * `feedback_updated_after_generation = true` on any non-superseded
 * `generated_reports` rows for that period, so the UI can display a "stale"
 * marker against existing reports without us writing extra SQL here.
 */
export async function updateManagerFeedbackAction(formData: FormData) {
  const performance_record_id = String(formData.get("performance_record_id") ?? "");
  const employee_id = String(formData.get("employee_id") ?? "");
  const feedback = String(formData.get("manager_feedback") ?? "");

  if (!performance_record_id || !employee_id) return;

  const supabase = await createClient();
  const trimmed = feedback.trim();

  const { error } = await supabase
    .from("performance_records")
    .update({
      manager_feedback: trimmed.length > 0 ? trimmed : null,
    })
    .eq("id", performance_record_id);

  if (error) {
    console.error("[manager-feedback] save failed:", error);
    redirect(
      `/dashboard/employees/${employee_id}?feedback_error=${encodeURIComponent(
        error.message
      )}`
    );
  }

  revalidatePath(`/dashboard/employees/${employee_id}`);
  redirect(
    `/dashboard/employees/${employee_id}?feedback_saved=${performance_record_id}`
  );
}
