"use server";
import { revalidatePath } from "next/cache";
import { renderToBuffer } from "@react-pdf/renderer";
import React from "react";
import { PDFDocument } from "pdf-lib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  EmployeeReportDocument,
  TEMPLATE_VERSION,
  type ReportData,
  type TrailingQuarter,
  type MetricSnapshot,
} from "@/lib/pdf/EmployeeReport";
import {
  EmployeeTaskDetailReportDocument,
} from "@/lib/pdf/EmployeeTaskDetailReport";
import { buildTaskDetailData } from "./generate-task-detail-actions";

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isNaN(n) ? null : n;
}

/**
 * Concatenate two PDF byte buffers into a single PDF (PDF B's pages appended
 * to PDF A's). Used to bundle the Task Detail report onto the end of the
 * Performance Report when the "+Task detail" checkbox is set.
 */
async function mergePdfBuffers(a: Buffer, b: Buffer): Promise<Buffer> {
  const merged = await PDFDocument.create();
  const docA = await PDFDocument.load(a);
  const docB = await PDFDocument.load(b);
  const aPages = await merged.copyPages(docA, docA.getPageIndices());
  for (const p of aPages) merged.addPage(p);
  const bPages = await merged.copyPages(docB, docB.getPageIndices());
  for (const p of bPages) merged.addPage(p);
  const bytes = await merged.save();
  return Buffer.from(bytes);
}

export interface RenderAndStoreResult {
  ok: boolean;
  error?: string;
  report_id?: string;
  storage_path?: string;
  task_detail_included?: boolean;
  task_detail_note?: string | null;
}

/**
 * Build, render, upload, and persist a Performance report for one
 * (employee, performance_record). Optionally bundles the Task Detail report
 * onto the end of the same PDF and inserts a single generated_reports row.
 *
 * Pure helper — does NOT call revalidatePath. Single-employee and
 * bulk-from-location callers are responsible for invalidating their own
 * caches after looping.
 */
export async function renderAndStorePerformanceReport(
  supabase: SupabaseClient,
  performance_record_id: string,
  opts: { include_task_detail: boolean; generated_by: string | null }
): Promise<RenderAndStoreResult> {
  const { data: pr, error } = await supabase
    .from("performance_records")
    .select(
      `id, employee_id, location_id, report_period_id, manager_feedback,
       attendance_pct, on_time_pct, on_time_grace_pct, covered_shifts,
       survey_engagement_pct, surveys_assigned, surveys_completed,
       customer_service_rating, customer_review_quantity,
       tattle_rating, tattle_quantity,
       tattle_score_food_quality, tattle_score_accuracy, tattle_score_speed_of_service,
       employees(employee_name, employee_code, hire_date),
       locations(name),
       report_periods(label, period_start, period_end)`
    )
    .eq("id", performance_record_id)
    .single();
  if (error || !pr) {
    return { ok: false, error: error?.message ?? "performance_record not found" };
  }

  const emp = pr.employees as unknown as {
    employee_name: string;
    employee_code: string;
    hire_date: string | null;
  } | null;
  const loc = pr.locations as unknown as { name: string } | null;
  const period = pr.report_periods as unknown as {
    label: string;
    period_start: string;
    period_end: string;
  } | null;
  if (!emp || !loc || !period) {
    return { ok: false, error: "missing related employee/location/period" };
  }

  // ---- Trailing quarters (last 4 incl. current) for Δ + sparkline + trend page ----
  // Pull every performance_record for this employee whose quarter starts on
  // or before the current quarter, take the 4 most recent, then reverse to
  // oldest-first so the current quarter is the LAST entry.
  const { data: trailingRows } = await supabase
    .from("performance_records")
    .select(
      `attendance_pct, on_time_pct, on_time_grace_pct, covered_shifts,
       survey_engagement_pct, surveys_assigned, surveys_completed,
       customer_service_rating, customer_review_quantity,
       tattle_rating, tattle_quantity,
       tattle_score_food_quality, tattle_score_accuracy, tattle_score_speed_of_service,
       report_periods!inner(label, period_start)`
    )
    .eq("employee_id", pr.employee_id)
    .eq("location_id", pr.location_id)
    .lte("report_periods.period_start", period.period_start)
    .order("period_start", { foreignTable: "report_periods", ascending: false })
    .limit(4);

  type TrailingDbRow = {
    attendance_pct: number | string | null;
    on_time_pct: number | string | null;
    on_time_grace_pct: number | string | null;
    covered_shifts: number | null;
    survey_engagement_pct: number | string | null;
    surveys_assigned: number | null;
    surveys_completed: number | null;
    customer_service_rating: number | string | null;
    customer_review_quantity: number | null;
    tattle_rating: number | string | null;
    tattle_quantity: number | null;
    tattle_score_food_quality: number | string | null;
    tattle_score_accuracy: number | string | null;
    tattle_score_speed_of_service: number | string | null;
    report_periods: { label: string; period_start: string } | null;
  };
  const rowsAsc = ((trailingRows ?? []) as unknown as TrailingDbRow[])
    .filter((r) => r.report_periods)
    // Foreign-table .order() in Supabase doesn't always sort the parent rows;
    // re-sort defensively then reverse to oldest-first.
    .sort((a, b) =>
      (b.report_periods!.period_start ?? "").localeCompare(
        a.report_periods!.period_start ?? ""
      )
    )
    .reverse();
  const trailing_quarters: TrailingQuarter[] = rowsAsc.map((r) => {
    const snap: MetricSnapshot = {
      // Reports use the grace value as the canonical "On Time %"
      on_time_pct: num(r.on_time_grace_pct),
      attendance_pct: num(r.attendance_pct),
      covered_shifts: r.covered_shifts,
      survey_engagement_pct: num(r.survey_engagement_pct),
      surveys_assigned: r.surveys_assigned,
      surveys_completed: r.surveys_completed,
      customer_service_rating: num(r.customer_service_rating),
      customer_review_quantity: r.customer_review_quantity,
      tattle_rating: num(r.tattle_rating),
      tattle_quantity: r.tattle_quantity,
      tattle_score_food_quality: num(r.tattle_score_food_quality),
      tattle_score_accuracy: num(r.tattle_score_accuracy),
      tattle_score_speed_of_service: num(r.tattle_score_speed_of_service),
    };
    return {
      label: r.report_periods!.label,
      period_start: r.report_periods!.period_start,
      metrics: snap,
    };
  });

  const generated_at = new Date().toISOString();
  const reportData: ReportData = {
    employee_name: emp.employee_name,
    employee_code: emp.employee_code,
    location_name: loc.name,
    hire_date: emp.hire_date,
    report_period_label: period.label,
    report_period_end: period.period_end,
    metrics: {
      // Reports display the 3-minute-grace on-time number (not the strict
      // value). See classify.ts thresholds for how this is bucketed.
      on_time_pct: num(pr.on_time_grace_pct),
      attendance_pct: num(pr.attendance_pct),
      covered_shifts: pr.covered_shifts,
      survey_engagement_pct: num(pr.survey_engagement_pct),
      surveys_assigned: pr.surveys_assigned as number | null,
      surveys_completed: pr.surveys_completed as number | null,
      customer_service_rating: num(pr.customer_service_rating),
      customer_review_quantity: pr.customer_review_quantity,
      tattle_rating: num(pr.tattle_rating),
      tattle_quantity: pr.tattle_quantity,
      tattle_score_food_quality: num(pr.tattle_score_food_quality),
      tattle_score_accuracy: num(pr.tattle_score_accuracy),
      tattle_score_speed_of_service: num(pr.tattle_score_speed_of_service),
    },
    manager_feedback: pr.manager_feedback as string | null,
    generated_at,
    trailing_quarters,
  };

  // Render the performance PDF. Cast through unknown because the wrapper
  // component's props type doesn't match @react-pdf's DocumentProps signature.
  const perfDoc = React.createElement(EmployeeReportDocument, { data: reportData });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let buffer = await renderToBuffer(perfDoc as any);

  let task_detail_included = false;
  let task_detail_note: string | null = null;
  if (opts.include_task_detail) {
    try {
      const tdData = await buildTaskDetailData(supabase, performance_record_id);
      if (!tdData) {
        task_detail_note = "Could not build task detail data.";
      } else {
        const tdDoc = React.createElement(EmployeeTaskDetailReportDocument, {
          data: tdData,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tdBuffer = await renderToBuffer(tdDoc as any);
        buffer = await mergePdfBuffers(buffer, tdBuffer);
        task_detail_included = true;
      }
    } catch (e) {
      task_detail_note = (e as Error).message;
    }
  }

  const safeName = emp.employee_name.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const safePeriod = period.label.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const suffix = task_detail_included ? "_with_task_detail" : "";
  const storage_path = `${pr.location_id}/${pr.employee_id}/${safePeriod}_${safeName}${suffix}_${Date.now()}.pdf`;

  const { error: uploadError } = await supabase.storage
    .from("reports")
    .upload(storage_path, buffer, {
      contentType: "application/pdf",
      upsert: false,
    });
  if (uploadError) return { ok: false, error: `upload: ${uploadError.message}` };

  const thresholdSnapshot = {
    template_version: TEMPLATE_VERSION,
    on_time_pct: { meets: 90, exceeds: 95 },
    attendance_pct: { meets: 95, exceeds: 100 },
    survey_engagement_pct: { meets: 80, exceeds: 85 },
    tattle_rating: { meets: 4.25 },
    tattle_score_food_quality: { meets: 90 },
    tattle_score_accuracy: { meets: 90 },
    tattle_score_speed_of_service: { meets: 90 },
    customer_service_rating: { meets: 4.25 },
  };

  await supabase
    .from("generated_reports")
    .update({ superseded_at: generated_at })
    .eq("employee_id", pr.employee_id)
    .eq("report_period_id", pr.report_period_id)
    .eq("report_kind", "performance")
    .is("superseded_at", null);

  const { data: inserted, error: insertError } = await supabase
    .from("generated_reports")
    .insert({
      performance_record_id: pr.id,
      employee_id: pr.employee_id,
      location_id: pr.location_id,
      report_period_id: pr.report_period_id,
      generation_mode: "quarterly",
      report_kind: "performance",
      storage_path,
      template_version: TEMPLATE_VERSION,
      threshold_snapshot: thresholdSnapshot,
      generated_at,
      generated_by: opts.generated_by,
      feedback_updated_after_generation: false,
    })
    .select("id")
    .single();
  if (insertError) return { ok: false, error: `insert: ${insertError.message}` };

  await supabase
    .from("locations")
    .update({ last_report_generated_at: generated_at })
    .eq("id", pr.location_id);

  return {
    ok: true,
    report_id: inserted?.id as string,
    storage_path,
    task_detail_included,
    task_detail_note,
  };
}

export async function generatePerformanceReportAction(formData: FormData) {
  const performance_record_id = String(formData.get("performance_record_id") ?? "");
  const employee_id = String(formData.get("employee_id") ?? "");
  const include_task_detail = formData.get("include_task_detail") === "1";
  if (!performance_record_id || !employee_id) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const result = await renderAndStorePerformanceReport(supabase, performance_record_id, {
    include_task_detail,
    generated_by: user?.id ?? null,
  });

  if (!result.ok) {
    console.error("[report-gen] failed:", result.error);
    return;
  }
  console.log(
    `[report-gen] generated ${result.storage_path}` +
      (result.task_detail_included ? " (with task detail bundled)" : "") +
      (result.task_detail_note ? ` [task-detail-note: ${result.task_detail_note}]` : "")
  );

  revalidatePath(`/dashboard/employees/${employee_id}`);
  // location_id is needed for revalidation but the helper already updated it.
  // Refetch a minimal record to find the location for revalidation only:
  const { data: locOnly } = await supabase
    .from("performance_records")
    .select("location_id")
    .eq("id", performance_record_id)
    .single();
  if (locOnly?.location_id) {
    revalidatePath(`/dashboard/locations/${locOnly.location_id}`);
  }
}
