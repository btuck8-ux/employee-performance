"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { writeManagerFeedback } from "@/lib/manager-feedback";

/**
 * Save manager feedback for a single (employee, quarter) performance_record.
 * The write goes through the SHARED writer (src/lib/manager-feedback.ts —
 * also used by the Reports builder; single-writer rule, kickoff 2026-08-19).
 * The DB-side trigger on `performance_records.manager_feedback` flips
 * `feedback_updated_after_generation = true` on any non-superseded
 * `generated_reports` rows for that period, so the UI can display a "stale"
 * marker against existing reports without us writing extra SQL here; the
 * writer skips no-op saves so an unchanged submit can't stale-flag anything.
 */
export async function updateManagerFeedbackAction(formData: FormData) {
  const performance_record_id = String(formData.get("performance_record_id") ?? "");
  const employee_id = String(formData.get("employee_id") ?? "");
  const feedback = String(formData.get("manager_feedback") ?? "");

  if (!performance_record_id || !employee_id) return;

  const supabase = await createClient();
  const trimmed = feedback.trim();

  const result = await writeManagerFeedback(
    supabase,
    performance_record_id,
    trimmed.length > 0 ? trimmed : null
  );

  if (!result.ok) {
    console.error("[manager-feedback] save failed:", result.error);
    redirect(
      `/dashboard/employees/${employee_id}?feedback_error=${encodeURIComponent(
        result.error ?? "unknown"
      )}`
    );
  }

  revalidatePath(`/dashboard/employees/${employee_id}`);
  redirect(
    `/dashboard/employees/${employee_id}?feedback_saved=${performance_record_id}`
  );
}
