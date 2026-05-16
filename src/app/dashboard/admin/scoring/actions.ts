"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  fetchCustomerServiceWeights,
  type CustomerServiceWeights,
} from "@/lib/customer-service-score";
import { recomputePerformanceForQuarter } from "@/lib/performance-recompute";
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

  const supabase = await createClient();

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
