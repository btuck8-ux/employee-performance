"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import { renderAndStorePerformanceReport } from "@/app/dashboard/employees/[id]/generate-report-actions";
import { renderAndStoreCustomRangeReport } from "@/app/dashboard/employees/[id]/generate-custom-range-actions";
import { writeManagerFeedback } from "@/lib/manager-feedback";
import {
  resolveIncludedMetricKeys,
  type ReportRenderOptions,
} from "@/lib/report-render-options";

/**
 * Reports-page custom builder (kickoff §5e): scope pickers + period + kind,
 * generating through the EXISTING report cores — no new generation logic:
 *   quarterly  → renderAndStorePerformanceReport (per performance_record)
 *   range      → renderAndStoreCustomRangeReport (per employee)
 *
 * SA-only server-side (locked: report generation is a write and writes are
 * SA-only this sprint); the page render-gates the builder for other tiers.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar-valid ISO date (rejects pattern-passing junk like 2025-13-99). */
function isValidIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Per-invocation ceiling — the largest store is ~40 active employees; a
 * bigger ask means a mis-scoped selection, not a real workload. */
const MAX_TARGETS = 60;

function back(params: Record<string, string>): never {
  const qs = new URLSearchParams(params).toString();
  redirect(`/dashboard/reports${qs ? `?${qs}` : ""}`);
}

export async function generateReportsBuilderAction(formData: FormData) {
  const locationId = String(formData.get("location_id") ?? "");
  const employeeIds = formData
    .getAll("employee_ids")
    .map((v) => String(v))
    .filter(Boolean);
  const periodMode = String(formData.get("period_mode") ?? "quarter");
  const reportPeriodId = String(formData.get("report_period_id") ?? "");
  const rangeStart = String(formData.get("range_start") ?? "");
  const rangeEnd = String(formData.get("range_end") ?? "");
  const includeTaskDetail = formData.get("include_task_detail") === "1";

  // §5-B: metric-group checkboxes + review/tattle display toggles → the set
  // of PDF rows that RENDER (computation untouched). All-on → null (today's
  // full PDF, byte-identical default).
  const selectedGroups = formData.getAll("metrics").map((v) => String(v));
  const includeReviews = formData.get("include_reviews") === "1";
  const includeTattles = formData.get("include_tattles") === "1";
  // §5-C: feedback text + include/exclude toggle. Empty text = DON'T TOUCH
  // the stored value (never a clear — clearing stays on the profile editor).
  const feedbackText = String(formData.get("manager_feedback_text") ?? "").trim();
  const includeFeedback = formData.get("include_manager_feedback") === "1";

  const renderOptions: ReportRenderOptions = {
    included_metric_keys: resolveIncludedMetricKeys(
      selectedGroups,
      includeReviews,
      includeTattles
    ),
    include_manager_feedback: includeFeedback,
  };

  const { supabase, user, role } = await getSessionRole();
  if (!user || role !== "system_admin") {
    console.warn("[reports-builder] denied", { user_id: user?.id ?? null, role });
    redirect("/dashboard/reports");
  }
  if (!locationId) back({ builder_error: "Pick a location first." });

  // Empty selection = every active employee at the location (the bulk case).
  let targets = employeeIds;
  if (targets.length === 0) {
    const { data } = await supabase
      .from("employees")
      .select("id")
      .eq("location_id", locationId)
      .eq("active", true);
    targets = (data ?? []).map((e) => e.id as string);
  }
  if (targets.length === 0) {
    back({ builder_error: "No employees to generate for.", builder_location: locationId });
  }
  if (targets.length > MAX_TARGETS) {
    back({
      builder_error: `Refusing to generate ${targets.length} reports in one pass (max ${MAX_TARGETS}) — narrow the selection.`,
      builder_location: locationId,
    });
  }

  const generated: string[] = [];
  const failures: string[] = [];

  if (periodMode === "range") {
    if (!isValidIsoDate(rangeStart) || !isValidIsoDate(rangeEnd) || rangeStart > rangeEnd) {
      back({
        builder_error: "Custom range needs valid start/end dates (start ≤ end).",
        builder_location: locationId,
      });
    }
    for (const employeeId of targets) {
      const r = await renderAndStoreCustomRangeReport(
        supabase,
        employeeId,
        rangeStart,
        rangeEnd,
        { render_options: renderOptions }
      );
      if (r.ok) generated.push(r.report_id);
      else failures.push(r.error);
    }
  } else {
    if (!reportPeriodId) {
      back({ builder_error: "Pick a quarter.", builder_location: locationId });
    }
    const { data: records } = await supabase
      .from("performance_records")
      .select("id, employee_id")
      .eq("location_id", locationId)
      .eq("report_period_id", reportPeriodId)
      .in("employee_id", targets);
    const byEmployee = new Map(
      (records ?? []).map((r) => [r.employee_id as string, r.id as string])
    );
    // §5-C: the feedback field applies ONLY to a single-employee quarterly
    // run (delegated micro-call: disabled rather than prompted-per-employee
    // for multi-employee runs; the UI hides it when ≠1 selected and this
    // guard enforces it server-side). The write happens BEFORE generation:
    // the DB trigger stale-flags existing non-superseded reports, then the
    // fresh insert starts feedback_updated_after_generation=false — so
    // feedback + generate in one submission is NOT stale by construction.
    // The shared writer skips no-op saves, so unchanged text can't
    // stale-flag sibling (e.g. task-detail) reports.
    if (feedbackText && targets.length === 1) {
      const recordId = byEmployee.get(targets[0]);
      if (recordId) {
        const fb = await writeManagerFeedback(supabase, recordId, feedbackText);
        if (!fb.ok) {
          back({
            builder_error: `Feedback save failed: ${fb.error ?? "unknown"} — report NOT generated.`,
            builder_location: locationId,
          });
        }
      }
    }

    for (const employeeId of targets) {
      const recordId = byEmployee.get(employeeId);
      if (!recordId) {
        failures.push(`No performance record for employee ${employeeId} in that quarter.`);
        continue;
      }
      const r = await renderAndStorePerformanceReport(supabase, recordId, {
        include_task_detail: includeTaskDetail,
        generated_by: user.id,
        render_options: renderOptions,
      });
      if (r.ok && r.report_id) generated.push(r.report_id);
      else failures.push(r.error ?? "unknown failure");
    }
  }

  console.log("[reports-builder] done", {
    actor: user.id,
    location_id: locationId,
    generated: generated.length,
    failures: failures.length,
  });

  revalidatePath("/dashboard/reports");
  const params: Record<string, string> = { builder_location: locationId };
  if (generated.length > 0) params.generated = generated.join(",");
  if (failures.length > 0) {
    params.builder_error = `${failures.length} failure(s): ${failures.slice(0, 3).join(" | ")}`;
  }
  back(params);
}
