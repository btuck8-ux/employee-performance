"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  parseCustomerReviewsCsv,
  type ParsedReview,
} from "@/lib/customer-review-import";
import { recomputePerformanceForQuarter } from "@/lib/performance-recompute";
import { quarterOfDate, type Quarter } from "@/lib/quarter";
import { rowMatchesLocation } from "@/lib/location-match";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

const UPSERT_BATCH_SIZE = 250;

interface AttributionContext {
  workedByDate: Map<
    string,
    { employee_id: string; in_time: string | null; out_time: string | null }[]
  >;
}

interface ImportSummary {
  reviews_inserted: number;
  reviews_updated: number;
  attributions_inserted: number;
  attribution_method_counts: Record<"on_shift_at_experienced" | "worked_that_day" | "none", number>;
  warnings: string[];
  failures: string[];
}

function attributeReview(
  review: ParsedReview,
  ctx: AttributionContext
): { employee_id: string; method: "on_shift_at_experienced" | "worked_that_day" }[] {
  if (!review.review_date) return [];
  const dayShifts = ctx.workedByDate.get(review.review_date) ?? [];
  if (dayShifts.length === 0) return [];

  let onShift: typeof dayShifts = [];
  if (review.review_datetime) {
    const expTime = review.review_datetime.slice(11, 19); // "HH:MM:SS"
    // Reviews with 00:00:00 (Yelp) won't match any in-shift window — fall through to worked-that-day.
    if (expTime !== "00:00:00") {
      onShift = dayShifts.filter((s) => {
        if (!s.in_time || !s.out_time) return false;
        return s.in_time <= expTime && expTime <= s.out_time;
      });
    }
  }

  if (onShift.length > 0) {
    return onShift.map((s) => ({
      employee_id: s.employee_id,
      method: "on_shift_at_experienced" as const,
    }));
  }
  return dayShifts.map((s) => ({
    employee_id: s.employee_id,
    method: "worked_that_day" as const,
  }));
}

async function chunkUpsert<T>(
  upsertFn: (batch: T[]) => Promise<{ error: { message: string } | null }>,
  rows: T[],
  label: string,
  summary: ImportSummary
) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await upsertFn(batch);
    if (error) {
      const msg = `${label} batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}: ${error.message}`;
      console.error("[review-import]", msg);
      summary.failures.push(msg);
    }
  }
}

export async function uploadCustomerReviewsCsvAction(formData: FormData) {
  console.log("[review-import] uploadCustomerReviewsCsvAction invoked");

  const location_id = String(formData.get("location_id") ?? "");
  const file = formData.get("file") as File | null;

  if (!location_id) {
    redirect(
      `/dashboard/locations?review_error=${encodeURIComponent("Missing location.")}`
    );
  }
  if (!file || file.size === 0) {
    redirect(
      `/dashboard/locations/${location_id}?review_error=${encodeURIComponent("No file uploaded.")}`
    );
  }

  const supabase = await createClient();
  const text = await file.text();
  const parsed = parseCustomerReviewsCsv(text);
  console.log(
    `[review-import] parsed ${parsed.rows_in_file} rows -> ${parsed.unique_reviews} unique reviews`
  );

  if (parsed.errors.length > 0 && parsed.reviews.length === 0) {
    redirect(
      `/dashboard/locations/${location_id}?review_error=${encodeURIComponent(
        parsed.errors.join("; ")
      )}`
    );
  }

  // Filter out rows tagged for other locations (using external_location_label).
  const { data: locRow } = await supabase
    .from("locations")
    .select("name, csv_aliases")
    .eq("id", location_id)
    .single();
  const targetLocationName = (locRow?.name as string | undefined) ?? "";
  const targetAliases = (locRow?.csv_aliases as string[] | null | undefined) ?? null;
  const beforeFilter = parsed.reviews.length;
  parsed.reviews = parsed.reviews.filter((r) =>
    rowMatchesLocation(r.external_location_label, targetLocationName, targetAliases)
  );
  const reviewSkippedOtherLocation = beforeFilter - parsed.reviews.length;
  if (reviewSkippedOtherLocation > 0) {
    console.log(
      `[review-import] filtered out ${reviewSkippedOtherLocation} reviews tagged for other locations`
    );
  }

  // Build attribution context
  const { data: workedEntries } = await supabase
    .from("time_entries")
    .select("employee_id, entry_date, in_time, out_time")
    .eq("location_id", location_id)
    .eq("entry_type", "worked")
    .range(0, 99999);

  const ctx: AttributionContext = { workedByDate: new Map() };
  for (const e of workedEntries ?? []) {
    const list = ctx.workedByDate.get(e.entry_date);
    const item = {
      employee_id: e.employee_id,
      in_time: e.in_time as string | null,
      out_time: e.out_time as string | null,
    };
    if (list) list.push(item);
    else ctx.workedByDate.set(e.entry_date, [item]);
  }
  console.log(
    `[review-import] attribution context: ${workedEntries?.length ?? 0} worked entries across ${ctx.workedByDate.size} days`
  );

  // Pre-fetch existing reviews for this location
  const { data: existingReviews } = await supabase
    .from("customer_reviews")
    .select("id, external_review_id")
    .eq("location_id", location_id)
    .range(0, 99999);

  const existingByReviewId = new Map<string, string>();
  for (const r of existingReviews ?? []) {
    existingByReviewId.set(r.external_review_id, r.id);
  }

  const summary: ImportSummary = {
    reviews_inserted: 0,
    reviews_updated: 0,
    attributions_inserted: 0,
    attribution_method_counts: { on_shift_at_experienced: 0, worked_that_day: 0, none: 0 },
    warnings: parsed.warnings.slice(0, 10),
    failures: [],
  };

  // Phase 1: bulk upsert reviews
  const reviewPayloads = parsed.reviews.map((r) => ({
    location_id,
    external_review_id: r.external_review_id,
    provider_name: r.provider_name,
    external_location_id: r.external_location_id,
    external_location_label: r.external_location_label,
    rating: r.rating,
    reviewer: r.reviewer,
    review_text: r.review_text,
    review_url: r.review_url,
    review_datetime: r.review_datetime,
    review_date: r.review_date,
    response_text: r.response_text,
    response_datetime: r.response_datetime,
    response_status: r.response_status,
    response_username: r.response_username,
    response_type: r.response_type,
  }));

  for (const r of parsed.reviews) {
    if (existingByReviewId.has(r.external_review_id)) summary.reviews_updated += 1;
    else summary.reviews_inserted += 1;
  }

  await chunkUpsert(
    async (batch: typeof reviewPayloads) =>
      await supabase
        .from("customer_reviews")
        .upsert(batch, { onConflict: "location_id,external_review_id" }),
    reviewPayloads,
    "customer_reviews",
    summary
  );

  // Get IDs back
  const { data: nowReviews } = await supabase
    .from("customer_reviews")
    .select("id, external_review_id, review_date, review_datetime")
    .eq("location_id", location_id)
    .range(0, 99999);

  const reviewIdByExt = new Map<
    string,
    { id: string; date: string | null; datetime: string | null }
  >();
  for (const r of nowReviews ?? []) {
    reviewIdByExt.set(r.external_review_id, {
      id: r.id,
      date: r.review_date,
      datetime: (r.review_datetime as string | null) ?? null,
    });
  }

  // Phase 2: compute attributions
  const attributionPayloads: Array<{
    customer_review_id: string;
    employee_id: string;
    attribution_method: "on_shift_at_experienced" | "worked_that_day";
  }> = [];
  const affectedKeys = new Set<string>();

  for (const r of parsed.reviews) {
    const ref = reviewIdByExt.get(r.external_review_id);
    if (!ref || !ref.date) continue;
    const att = attributeReview(r, ctx);
    if (att.length === 0) {
      summary.attribution_method_counts.none += 1;
      continue;
    }
    for (const a of att) {
      attributionPayloads.push({
        customer_review_id: ref.id,
        employee_id: a.employee_id,
        attribution_method: a.method,
      });
      summary.attribution_method_counts[a.method] += 1;
      const q = quarterOfDate(new Date(ref.date));
      affectedKeys.add(`${a.employee_id}|${q.year}|${q.quarter}`);
    }
  }

  // Replace attributions for the imported reviews
  const importedReviewIds = parsed.reviews
    .map((r) => reviewIdByExt.get(r.external_review_id)?.id)
    .filter((x): x is string => Boolean(x));

  if (importedReviewIds.length > 0) {
    for (let i = 0; i < importedReviewIds.length; i += 500) {
      const chunk = importedReviewIds.slice(i, i + 500);
      const { error: delErr } = await supabase
        .from("review_attributions")
        .delete()
        .in("customer_review_id", chunk);
      if (delErr) {
        console.error("[review-import] delete attributions chunk error:", delErr);
        summary.failures.push(`delete attributions: ${delErr.message}`);
      }
    }
  }

  await chunkUpsert(
    async (batch: typeof attributionPayloads) =>
      await supabase.from("review_attributions").insert(batch),
    attributionPayloads,
    "review_attributions",
    summary
  );
  summary.attributions_inserted = attributionPayloads.length;

  console.log(
    `[review-import] reviews ${summary.reviews_inserted}+${summary.reviews_updated}u, ` +
      `attributions=${summary.attributions_inserted} ` +
      `(on_shift=${summary.attribution_method_counts.on_shift_at_experienced}, ` +
      `worked_day=${summary.attribution_method_counts.worked_that_day}, ` +
      `unattributed=${summary.attribution_method_counts.none})`
  );

  // Phase 3: recompute performance
  let recomputed = 0;
  for (const key of affectedKeys) {
    const [employee_id, yearStr, quarterStr] = key.split("|");
    const year = parseInt(yearStr, 10);
    const quarter = parseInt(quarterStr, 10) as Quarter;
    const result = await recomputePerformanceForQuarter(
      supabase as SupabaseServer,
      employee_id,
      location_id,
      year,
      quarter
    );
    if (result.ok) recomputed += 1;
    else summary.failures.push(`Recompute ${employee_id} ${year}-Q${quarter}: ${result.error}`);
  }
  console.log(`[review-import] recomputed ${recomputed} performance_records`);

  await supabase
    .from("locations")
    .update({ last_data_uploaded_at: new Date().toISOString() })
    .eq("id", location_id);

  revalidatePath(`/dashboard/locations/${location_id}`);
  revalidatePath("/dashboard/employees");

  const params = new URLSearchParams();
  params.set("review_in", String(summary.reviews_inserted));
  params.set("review_up", String(summary.reviews_updated));
  params.set("review_att", String(summary.attributions_inserted));
  params.set("review_onshift", String(summary.attribution_method_counts.on_shift_at_experienced));
  params.set("review_workday", String(summary.attribution_method_counts.worked_that_day));
  params.set("review_unatt", String(summary.attribution_method_counts.none));
  params.set("review_recomputed", String(recomputed));
  if (reviewSkippedOtherLocation > 0)
    params.set("review_skipped_other_location", String(reviewSkippedOtherLocation));
  if (summary.warnings.length > 0)
    params.set("review_warnings", summary.warnings.slice(0, 3).join(" | "));
  if (summary.failures.length > 0)
    params.set("review_failures", summary.failures.slice(0, 3).join(" | "));

  redirect(`/dashboard/locations/${location_id}?${params.toString()}`);
}
