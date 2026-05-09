"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { renderAndStorePerformanceReport } from "@/app/dashboard/employees/[id]/generate-report-actions";

/**
 * Bulk-generate quarterly Performance Reports for every active employee at
 * a location who has a performance_record for the chosen quarter.
 *
 * Notes on runtime:
 * - Generation is serial because each call renders a PDF and uploads it; running
 *   N at once would hammer Supabase Storage and likely race upsert conflicts.
 *   For a typical TSN location (10–30 employees) serial completes in ~30–90s.
 * - This action runs as a Vercel server action. Make sure the route's
 *   maxDuration is high enough on Pro (we should bump if locations grow).
 * - Partial success is OK: each employee's success/failure is independent,
 *   and the result counts are reported back via search params.
 */
export async function generateBulkLocationReportsAction(formData: FormData) {
  const location_id = String(formData.get("location_id") ?? "");
  const report_period_id = String(formData.get("report_period_id") ?? "");
  const include_task_detail = formData.get("include_task_detail") === "1";

  const back = `/dashboard/locations/${location_id}`;
  if (!location_id) return;
  if (!report_period_id) {
    redirect(`${back}?bulk_error=${encodeURIComponent("Pick a quarter first.")}`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Find every active employee at this location WITH a performance_record
  // for the chosen quarter. Employees without a record (e.g. hired after
  // the quarter ended) are silently skipped — they'll get listed as
  // "no_data" so the user can see who didn't get a report.
  const { data: activeEmployees } = await supabase
    .from("employees")
    .select("id, employee_name, employee_code")
    .eq("location_id", location_id)
    .eq("active", true)
    .order("employee_name");

  type EmpRow = { id: string; employee_name: string; employee_code: string };
  const empList = (activeEmployees ?? []) as unknown as EmpRow[];
  if (empList.length === 0) {
    redirect(`${back}?bulk_error=${encodeURIComponent("No active employees at this location.")}`);
  }

  const empIds = empList.map((e) => e.id);
  const { data: prRows } = await supabase
    .from("performance_records")
    .select("id, employee_id")
    .eq("location_id", location_id)
    .eq("report_period_id", report_period_id)
    .in("employee_id", empIds);

  const prByEmp = new Map<string, string>();
  for (const pr of prRows ?? []) {
    prByEmp.set(pr.employee_id as string, pr.id as string);
  }

  let okCount = 0;
  let failCount = 0;
  let bundledCount = 0;
  const noDataNames: string[] = [];
  const failureNotes: string[] = [];

  for (const e of empList) {
    const performance_record_id = prByEmp.get(e.id);
    if (!performance_record_id) {
      noDataNames.push(e.employee_name);
      continue;
    }
    try {
      const result = await renderAndStorePerformanceReport(
        supabase,
        performance_record_id,
        { include_task_detail, generated_by: user?.id ?? null }
      );
      if (result.ok) {
        okCount += 1;
        if (result.task_detail_included) bundledCount += 1;
      } else {
        failCount += 1;
        failureNotes.push(`${e.employee_name}: ${result.error}`);
        console.error(`[bulk-gen] ${e.employee_name}: ${result.error}`);
      }
    } catch (err) {
      failCount += 1;
      failureNotes.push(`${e.employee_name}: ${(err as Error).message}`);
      console.error(`[bulk-gen] ${e.employee_name} threw:`, err);
    }
  }

  // Single revalidation at the end (cheaper than per-loop)
  revalidatePath(back);
  revalidatePath("/dashboard/reports");

  const params = new URLSearchParams();
  params.set("bulk_ok", String(okCount));
  params.set("bulk_failed", String(failCount));
  params.set("bulk_skipped_no_data", String(noDataNames.length));
  params.set("bulk_bundled", String(bundledCount));
  if (noDataNames.length > 0) {
    params.set("bulk_no_data_names", noDataNames.slice(0, 10).join(", "));
  }
  if (failureNotes.length > 0) {
    params.set("bulk_failures", failureNotes.slice(0, 5).join(" | "));
  }
  redirect(`${back}?${params.toString()}`);
}
