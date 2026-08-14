"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import {
  fetchCustomerServiceWeights,
  type CustomerServiceWeights,
} from "@/lib/customer-service-score";
import {
  fetchTotalImpactWeights,
  type TotalImpactWeights,
} from "@/lib/total-impact-score";
import { recomputePerformanceForQuarter } from "@/lib/performance-recompute";
import { fetchMetricTargets, TARGET_METRICS } from "@/lib/metric-targets";
import type { Quarter } from "@/lib/quarter";

const RECOMPUTE_CONCURRENCY = 6;

/** Tolerance for the sum-to-one check, matches the SQL CHECK constraint. */
const WEIGHT_SUM_EPSILON = 0.001;

function parseWeight(raw: FormDataEntryValue | null): number {
  if (raw === null) return NaN;
  const s = String(raw).trim();
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Update the singleton `customer_service_score_config` row with new weights
 * and trigger a global recompute of every (employee, quarter) so existing
 * composite scores reflect the new weighting.
 *
 * The recompute is gated behind the `recompute=1` form value so the admin can
 * preview weight changes without immediately fanning out across the dataset.
 */
export async function updateCustomerServiceWeightsAction(formData: FormData) {
  const back = "/dashboard/admin/scoring";

  // system_admin only (Phase A, locked decision 3). Server actions are
  // directly POSTable, so the check lives here, not just on the page.
  const { role, supabase } = await getSessionRole();
  if (role !== "system_admin") redirect("/dashboard");

  const wTattle = parseWeight(formData.get("weight_tattle"));
  const wReviews = parseWeight(formData.get("weight_reviews"));
  const wTip = parseWeight(formData.get("weight_tip"));
  const recompute = formData.get("recompute") === "1";

  if (
    !Number.isFinite(wTattle) ||
    !Number.isFinite(wReviews) ||
    !Number.isFinite(wTip)
  ) {
    redirect(`${back}?error=${encodeURIComponent("All three weights must be numbers between 0 and 1.")}`);
  }
  if (wTattle < 0 || wReviews < 0 || wTip < 0) {
    redirect(`${back}?error=${encodeURIComponent("Weights cannot be negative.")}`);
  }
  if (wTattle > 1 || wReviews > 1 || wTip > 1) {
    redirect(`${back}?error=${encodeURIComponent("Each weight must be ≤ 1.")}`);
  }
  const sum = wTattle + wReviews + wTip;
  if (Math.abs(sum - 1) > WEIGHT_SUM_EPSILON) {
    redirect(
      `${back}?error=${encodeURIComponent(
        `Weights must sum to 1.000 (got ${sum.toFixed(4)}).`
      )}`
    );
  }

  // Update the singleton row. We don't need to know its id — just update the
  // single row in the table (matches partial unique index ((true))).
  const { data: existing } = await supabase
    .from("customer_service_score_config")
    .select("id")
    .limit(1)
    .maybeSingle();

  const payload = {
    weight_tattle: Number(wTattle.toFixed(3)),
    weight_reviews: Number(wReviews.toFixed(3)),
    weight_tip: Number(wTip.toFixed(3)),
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { error } = await supabase
      .from("customer_service_score_config")
      .update(payload)
      .eq("id", existing.id);
    if (error) {
      redirect(`${back}?error=${encodeURIComponent("DB update failed: " + error.message)}`);
    }
  } else {
    const { error } = await supabase
      .from("customer_service_score_config")
      .insert(payload);
    if (error) {
      redirect(`${back}?error=${encodeURIComponent("DB insert failed: " + error.message)}`);
    }
  }

  // Optional global recompute — needed any time the weights change so persisted
  // composite scores match the new config. Skipped when the admin just wants
  // to save weights without rerunning the heavy job.
  let recomputed = 0;
  let failures = 0;
  if (recompute) {
    const csWeights: CustomerServiceWeights = await fetchCustomerServiceWeights(supabase);
    const { data: prRows } = await supabase
      .from("performance_records")
      .select(
        "employee_id, location_id, report_periods!inner(year, quarter)"
      )
      .range(0, 99999);
    type Job = { employee_id: string; location_id: string; year: number; quarter: Quarter };
    const jobs: Job[] = ((prRows ?? []) as unknown as Array<{
      employee_id: string;
      location_id: string;
      report_periods: { year: number; quarter: number } | null;
    }>)
      .filter((r) => r.report_periods !== null)
      .map((r) => ({
        employee_id: r.employee_id,
        location_id: r.location_id,
        year: r.report_periods!.year,
        quarter: r.report_periods!.quarter as Quarter,
      }));

    async function worker() {
      while (true) {
        const job = jobs.shift();
        if (!job) return;
        const result = await recomputePerformanceForQuarter(
          supabase,
          job.employee_id,
          job.location_id,
          job.year,
          job.quarter,
          { csWeights }
        );
        if (result.ok) recomputed += 1;
        else failures += 1;
      }
    }
    await Promise.all(
      Array.from({ length: RECOMPUTE_CONCURRENCY }, worker)
    );
  }

  revalidatePath("/dashboard/admin/scoring");
  revalidatePath("/dashboard/employees");
  revalidatePath("/dashboard/locations");

  const params = new URLSearchParams();
  params.set("saved", "1");
  if (recompute) {
    params.set("recomputed", String(recomputed));
    if (failures > 0) params.set("failures", String(failures));
  }
  redirect(`${back}?${params.toString()}`);
}

/**
 * Update the singleton `total_impact_score_config` row and (optionally)
 * trigger a global recompute so persisted Total Impact Scores reflect the
 * new weighting. Mirrors `updateCustomerServiceWeightsAction` — see that
 * function for the why-each-step rationale.
 */
export async function updateTotalImpactWeightsAction(formData: FormData) {
  const back = "/dashboard/admin/scoring";

  // system_admin only (Phase A, locked decision 3) — same gate as the CS action.
  const { role, supabase } = await getSessionRole();
  if (role !== "system_admin") redirect("/dashboard");

  const wCs = parseWeight(formData.get("weight_cs_score"));
  const wAtt = parseWeight(formData.get("weight_attendance"));
  const wOn = parseWeight(formData.get("weight_on_time"));
  const wTasks = parseWeight(formData.get("weight_tasks"));
  const wSurvey = parseWeight(formData.get("weight_survey"));
  const recompute = formData.get("recompute") === "1";

  const five = [wCs, wAtt, wOn, wTasks, wSurvey];
  if (five.some((w) => !Number.isFinite(w))) {
    redirect(
      `${back}?tis_error=${encodeURIComponent("All five TIS weights must be numbers between 0 and 1.")}`
    );
  }
  if (five.some((w) => w < 0)) {
    redirect(`${back}?tis_error=${encodeURIComponent("Weights cannot be negative.")}`);
  }
  if (five.some((w) => w > 1)) {
    redirect(`${back}?tis_error=${encodeURIComponent("Each weight must be ≤ 1.")}`);
  }
  const sum = wCs + wAtt + wOn + wTasks + wSurvey;
  if (Math.abs(sum - 1) > WEIGHT_SUM_EPSILON) {
    redirect(
      `${back}?tis_error=${encodeURIComponent(
        `TIS weights must sum to 1.000 (got ${sum.toFixed(4)}).`
      )}`
    );
  }

  const { data: existing } = await supabase
    .from("total_impact_score_config")
    .select("id")
    .limit(1)
    .maybeSingle();

  const payload = {
    weight_cs_score: Number(wCs.toFixed(3)),
    weight_attendance: Number(wAtt.toFixed(3)),
    weight_on_time: Number(wOn.toFixed(3)),
    weight_tasks: Number(wTasks.toFixed(3)),
    weight_survey: Number(wSurvey.toFixed(3)),
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { error } = await supabase
      .from("total_impact_score_config")
      .update(payload)
      .eq("id", existing.id);
    if (error) {
      redirect(`${back}?tis_error=${encodeURIComponent("DB update failed: " + error.message)}`);
    }
  } else {
    const { error } = await supabase
      .from("total_impact_score_config")
      .insert(payload);
    if (error) {
      redirect(`${back}?tis_error=${encodeURIComponent("DB insert failed: " + error.message)}`);
    }
  }

  let recomputed = 0;
  let failures = 0;
  if (recompute) {
    // Reuse pre-fetched CS weights too so each recompute job avoids two
    // separate singleton round-trips.
    const csWeights: CustomerServiceWeights = await fetchCustomerServiceWeights(supabase);
    const tisWeights: TotalImpactWeights = await fetchTotalImpactWeights(supabase);
    const { data: prRows } = await supabase
      .from("performance_records")
      .select("employee_id, location_id, report_periods!inner(year, quarter)")
      .range(0, 99999);
    type Job = { employee_id: string; location_id: string; year: number; quarter: Quarter };
    const jobs: Job[] = ((prRows ?? []) as unknown as Array<{
      employee_id: string;
      location_id: string;
      report_periods: { year: number; quarter: number } | null;
    }>)
      .filter((r) => r.report_periods !== null)
      .map((r) => ({
        employee_id: r.employee_id,
        location_id: r.location_id,
        year: r.report_periods!.year,
        quarter: r.report_periods!.quarter as Quarter,
      }));

    async function worker() {
      while (true) {
        const job = jobs.shift();
        if (!job) return;
        const result = await recomputePerformanceForQuarter(
          supabase,
          job.employee_id,
          job.location_id,
          job.year,
          job.quarter,
          { csWeights, tisWeights }
        );
        if (result.ok) recomputed += 1;
        else failures += 1;
      }
    }
    await Promise.all(
      Array.from({ length: RECOMPUTE_CONCURRENCY }, worker)
    );
  }

  revalidatePath("/dashboard/admin/scoring");
  revalidatePath("/dashboard/employees");
  revalidatePath("/dashboard/locations");

  const params = new URLSearchParams();
  params.set("tis_saved", "1");
  if (recompute) {
    params.set("tis_recomputed", String(recomputed));
    if (failures > 0) params.set("tis_failures", String(failures));
  }
  redirect(`${back}?${params.toString()}`);
}

/**
 * Update the nine `metric_targets` rows (mig 051, 2026-08-14 targets
 * sprint). Same SA gate as the weight actions. NO recompute option on
 * purpose: targets drive classification labels only — composite math never
 * reads them — so stored scores are untouched by a target change.
 *
 * Cross-app contract: these values are mirrored in Training HQ (their side
 * is migration-config). Changes ship BOTH sides as a paired Tucker-approved
 * update — the page copy carries the same warning.
 *
 * Audit trail: one console line per save that changed anything, with actor
 * id + old→new per key (the employee-status/invite convention).
 */
export async function updateMetricTargetsAction(formData: FormData) {
  const back = "/dashboard/admin/scoring";

  // system_admin only — server actions are directly POSTable, so the check
  // lives here, not just on the page.
  const { role, user, supabase } = await getSessionRole();
  if (role !== "system_admin") redirect("/dashboard");

  const now = new Date().toISOString();
  const rows: Array<{ metric_key: string; target: number; updated_at: string }> = [];
  for (const m of TARGET_METRICS) {
    const n = parseWeight(formData.get(`target_${m.key}`));
    // Scale bounds mirror the migration's CHECK: ratings native 1–5 (a 0
    // rating target would mark everyone On Target), percents 0–100.
    const min = m.scale === "rating" ? 1 : 0;
    const max = m.scale === "rating" ? 5 : 100;
    if (!Number.isFinite(n) || n < min || n > max) {
      redirect(
        `${back}?mt_error=${encodeURIComponent(
          `${m.label} must be a number between ${min} and ${max}.`
        )}`
      );
    }
    rows.push({ metric_key: m.key, target: n, updated_at: now });
  }

  // Old values feed the audit line (old→new per changed key).
  const before = await fetchMetricTargets(supabase);

  const { error } = await supabase.from("metric_targets").upsert(rows);
  if (error) {
    redirect(`${back}?mt_error=${encodeURIComponent("DB update failed: " + error.message)}`);
  }

  const changes: Record<string, { from: number | null; to: number }> = {};
  for (const r of rows) {
    const prev = before[r.metric_key as (typeof TARGET_METRICS)[number]["key"]] ?? null;
    if (prev !== r.target) changes[r.metric_key] = { from: prev, to: r.target };
  }
  if (Object.keys(changes).length > 0) {
    console.log("[scoring] metric targets updated", {
      actor_id: user?.id ?? null,
      changes,
    });
  }

  revalidatePath("/dashboard/admin/scoring");
  revalidatePath("/dashboard/employees");
  revalidatePath("/dashboard/locations");

  redirect(`${back}?mt_saved=1`);
}
