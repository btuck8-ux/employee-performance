"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { renderToBuffer } from "@react-pdf/renderer";
import React from "react";
import { createClient } from "@/lib/supabase/server";
import {
  EmployeeReportDocument,
  TEMPLATE_VERSION,
  type ReportData,
} from "@/lib/pdf/EmployeeReport";
import { fetchCustomerServiceWeights } from "@/lib/customer-service-score";
import { getCategoryCurrency } from "@/lib/category-currency";
import { computeMetricsForRange } from "@/lib/performance-recompute";

/**
 * Build a human-readable label for a custom date range.
 * Examples:
 *   "Jan 15 – Mar 10, 2026"            (same year)
 *   "Dec 28, 2025 – Jan 14, 2026"      (crosses year)
 *   "Jan 15 – Jan 15, 2026"            (single day)
 */
function formatRangeLabel(start: string, end: string): string {
  const ms = start.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const me = end.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!ms || !me) return `${start} – ${end}`;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const sY = parseInt(ms[1], 10);
  const sM = parseInt(ms[2], 10);
  const sD = parseInt(ms[3], 10);
  const eY = parseInt(me[1], 10);
  const eM = parseInt(me[2], 10);
  const eD = parseInt(me[3], 10);
  if (sY === eY) {
    return `${months[sM - 1]} ${sD} – ${months[eM - 1]} ${eD}, ${eY}`;
  }
  return `${months[sM - 1]} ${sD}, ${sY} – ${months[eM - 1]} ${eD}, ${eY}`;
}

function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T12:00:00");
  return !Number.isNaN(d.getTime());
}

export type CustomRangeReportResult =
  | { ok: true; report_id: string; location_id: string }
  | { ok: false; error: string };

/**
 * Core of the custom-range report: compute metrics for [range_start,
 * range_end], render + upload the PDF, insert the generated_reports row.
 * Shared by the per-employee action below and the Reports-page builder
 * (kickoff §5e — reuse, not reimplementation). Caller validates dates.
 */
export async function renderAndStoreCustomRangeReport(
  supabase: Awaited<ReturnType<typeof createClient>>,
  employee_id: string,
  range_start: string,
  range_end: string
): Promise<CustomRangeReportResult> {
  const { data: emp, error: empErr } = await supabase
    .from("employees")
    .select(
      "id, employee_name, employee_code, hire_date, location_id, locations(name)"
    )
    .eq("id", employee_id)
    .single();
  if (empErr || !emp) {
    return { ok: false, error: "Employee not found." };
  }
  const location_id = emp.location_id as string;
  const loc = emp.locations as unknown as { name: string } | null;
  if (!loc) {
    return { ok: false, error: "Employee has no location." };
  }

  // Pull manager feedback that overlaps the custom range. Convention: latest
  // wins. The performance_records.manager_feedback is keyed by quarter, so
  // we union together all feedback whose quarter overlaps [start, end] and
  // pick the one whose period_start is closest-to-but-not-after range_end.
  const { data: feedbackRows } = await supabase
    .from("performance_records")
    .select(
      "manager_feedback, report_periods!inner(period_start, period_end)"
    )
    .eq("employee_id", employee_id)
    .gte("report_periods.period_end", range_start)
    .lte("report_periods.period_start", range_end);
  type FeedbackRow = {
    manager_feedback: string | null;
    report_periods: { period_start: string; period_end: string } | null;
  };
  const fb = ((feedbackRows ?? []) as unknown as FeedbackRow[])
    .filter((r) => r.manager_feedback && r.report_periods)
    .sort((a, b) =>
      (b.report_periods?.period_start ?? "").localeCompare(
        a.report_periods?.period_start ?? ""
      )
    );
  const manager_feedback = fb.length > 0 ? fb[0].manager_feedback : null;

  const csWeights = await fetchCustomerServiceWeights(supabase);
  const computed = await computeMetricsForRange(
    supabase,
    employee_id,
    location_id,
    range_start,
    range_end,
    { csWeights }
  );
  if (!computed.ok) {
    console.error("[custom-range] compute failed:", computed.error);
    return { ok: false, error: "Could not compute metrics: " + computed.error };
  }
  const m = computed.metrics;

  const generated_at = new Date().toISOString();
  const periodLabel = "Custom: " + formatRangeLabel(range_start, range_end);

  const reportData: ReportData = {
    employee_name: emp.employee_name as string,
    employee_code: emp.employee_code as string,
    location_name: loc.name,
    hire_date: (emp.hire_date as string | null) ?? null,
    report_period_label: periodLabel,
    report_period_end: range_end,
    metrics: {
      // Reports display the 3-minute-grace on-time number (not the strict
      // value). See generate-report-actions.ts for rationale.
      on_time_pct: m.on_time_grace_pct,
      attendance_pct: m.attendance_pct,
      covered_shifts: m.covered_shifts,
      survey_engagement_pct: m.survey_engagement_pct,
      surveys_assigned: m.surveys_assigned > 0 ? m.surveys_assigned : null,
      surveys_completed: m.surveys_assigned > 0 ? m.surveys_completed : null,
      customer_service_rating: m.customer_service_rating,
      customer_review_quantity:
        m.customer_review_quantity > 0 ? m.customer_review_quantity : null,
      tattle_rating: m.tattle_rating,
      tattle_quantity: m.tattle_quantity > 0 ? m.tattle_quantity : null,
      tattle_score_food_quality: m.tattle_score_food_quality,
      tattle_score_accuracy: m.tattle_score_accuracy,
      tattle_score_speed_of_service: m.tattle_score_speed_of_service,
      // Phase 7b: presence-based tip metrics, freshly computed over the
      // custom range by compute_employee_tip_metrics. Math is sum(tips) /
      // sum(sales) over the whole range — the mathematically correct
      // aggregation (NOT an unweighted average of quarter rates).
      tip_rate_pct: m.tip_rate_pct,
      tip_per_hour: m.tip_per_hour,
      location_tip_rate_pct: m.location_tip_rate_pct,
      location_tip_per_hour: m.location_tip_per_hour,
      tip_rate_delta_pp: m.tip_rate_delta_pp,
      // Kitchen Speed v2, freshly computed over the custom range by
      // compute_kitchen_speed (on-the-clock attribution, no role filter;
      // hour-matched residual vs the store's own norm). Renders at any
      // shift count (1.5.2) — short ranges show the number with the rating
      // badge withheld and a "directional only" footnote instead of hiding
      // the block.
      kitchen_items: m.kitchen_items,
      kitchen_tickets: m.kitchen_tickets,
      kitchen_shifts: m.kitchen_shifts,
      kitchen_avg_prep_seconds: m.kitchen_avg_prep_seconds,
      kitchen_baseline_prep_seconds: m.kitchen_baseline_prep_seconds,
      kitchen_residual_seconds: m.kitchen_residual_seconds,
      customer_service_score: m.customer_service_score,
      customer_service_score_components_count: m.customer_service_score_components_count,
    },
    manager_feedback,
    generated_at,
    customer_service_weights: csWeights,
    category_currency: await getCategoryCurrency(supabase, location_id, range_end),
  };

  const docElement = React.createElement(EmployeeReportDocument, { data: reportData });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buffer = await renderToBuffer(docElement as any);

  const safeName = (emp.employee_name as string).replace(/[^a-zA-Z0-9_-]+/g, "_");
  const safeRange = `${range_start}_to_${range_end}`;
  const storage_path = `${location_id}/${employee_id}/custom_${safeRange}_${safeName}_${Date.now()}.pdf`;

  const { error: uploadError } = await supabase.storage
    .from("reports")
    .upload(storage_path, buffer, {
      contentType: "application/pdf",
      upsert: false,
    });
  if (uploadError) {
    console.error("[custom-range] upload failed:", uploadError);
    return { ok: false, error: "Upload failed: " + uploadError.message };
  }

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
    customer_service_score: { yellow: 70, green: 85 },
  };

  const { data: { user } = { user: null } } = await supabase.auth.getUser();
  const { data: inserted, error: insertError } = await supabase
    .from("generated_reports")
    .insert({
      performance_record_id: null,
      employee_id,
      location_id,
      report_period_id: null,
      generation_mode: "custom_range",
      report_kind: "performance",
      custom_range: { start: range_start, end: range_end },
      storage_path,
      template_version: TEMPLATE_VERSION,
      threshold_snapshot: thresholdSnapshot,
      generated_at,
      generated_by: user?.id ?? null,
      feedback_updated_after_generation: false,
    })
    .select("id")
    .single();
  if (insertError || !inserted) {
    console.error("[custom-range] generated_reports insert failed:", insertError);
    return { ok: false, error: "DB insert failed: " + (insertError?.message ?? "unknown") };
  }

  await supabase
    .from("locations")
    .update({ last_report_generated_at: generated_at })
    .eq("id", location_id);

  console.log(
    `[custom-range] generated ${storage_path} for ${emp.employee_name} (${range_start} → ${range_end})`
  );

  return { ok: true, report_id: inserted.id as string, location_id };
}

export async function generateCustomRangePerformanceReportAction(formData: FormData) {
  const employee_id = String(formData.get("employee_id") ?? "");
  const range_start = String(formData.get("range_start") ?? "");
  const range_end = String(formData.get("range_end") ?? "");

  if (!employee_id) return;

  const back = `/dashboard/employees/${employee_id}`;

  if (!isValidDateString(range_start) || !isValidDateString(range_end)) {
    redirect(`${back}?range_error=${encodeURIComponent("Both dates are required (YYYY-MM-DD).")}`);
  }
  if (range_start > range_end) {
    redirect(`${back}?range_error=${encodeURIComponent("Start date must be on or before end date.")}`);
  }

  const supabase = await createClient();
  const result = await renderAndStoreCustomRangeReport(
    supabase,
    employee_id,
    range_start,
    range_end
  );
  if (!result.ok) {
    redirect(`${back}?range_error=${encodeURIComponent(result.error)}`);
  }

  revalidatePath(back);
  revalidatePath(`/dashboard/locations/${result.location_id}`);
  redirect(`${back}?range_report_id=${result.report_id}`);
}
