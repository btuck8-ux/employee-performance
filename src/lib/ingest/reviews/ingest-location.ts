/**
 * Per-location customer-reviews ingest — pure compute, no redirect/revalidate.
 *
 * Extracted from upload-review-actions.ts so the manual CSV upload and the
 * automated guest-feedback harvester share one filter → upsert → attribute →
 * recompute path (handoff §1). Accepts any SupabaseClient (SSR or admin).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type ParsedReview,
  type ReviewImportResult,
} from "@/lib/customer-review-import";
import { recomputePerformanceForQuarter } from "@/lib/performance-recompute";
import { fetchCustomerServiceWeights } from "@/lib/customer-service-score";
import { fetchTotalImpactWeights } from "@/lib/total-impact-score";
import { quarterOfDate, type Quarter } from "@/lib/quarter";
import { rowMatchesLocation } from "@/lib/location-match";

const UPSERT_BATCH_SIZE = 250;
const FETCH_PAGE = 1000;

interface AttributionContext {
  workedByDate: Map<
    string,
    { employee_id: string; in_time: string | null; out_time: string | null }[]
  >;
}

export interface IngestStats {
  reviews_inserted: number;
  reviews_updated: number;
  attributions_inserted: number;
  attribution_method_counts: Record<"on_shift_at_experienced" | "worked_that_day" | "none", number>;
  skipped_other_location: number;
  recomputed: number;
  warnings: string[];
  failures: string[];
}

export function newStats(warnings: string[] = []): IngestStats {
  return {
    reviews_inserted: 0,
    reviews_updated: 0,
    attributions_inserted: 0,
    attribution_method_counts: {
      on_shift_at_experienced: 0,
      worked_that_day: 0,
      none: 0,
    },
    skipped_other_location: 0,
    recomputed: 0,
    warnings,
    failures: [],
  };
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
    const expTime = review.review_datetime.slice(11, 19);
    // Yelp datetimes show 00:00:00 — skip the on-shift check and fall through.
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
  stats: IngestStats
) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await upsertFn(batch);
    if (error) {
      const msg = `${label} batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}: ${error.message}`;
      console.error("[review-import]", msg);
      stats.failures.push(msg);
    }
  }
}

/**
 * End-to-end review ingest for ONE location. Filters reviews by location,
 * upserts customer_reviews, computes attributions, recomputes affected
 * (employee, quarter) pairs. Uses date-filtered + paginated time-entry
 * fetch to avoid PostgREST's 1,000-row max-rows truncation.
 */
export async function ingestReviewsForLocation(
  supabase: SupabaseClient,
  parsed: ReviewImportResult,
  location: { id: string; name: string; csv_aliases: string[] | null }
): Promise<IngestStats> {
  const stats = newStats();

  const beforeFilter = parsed.reviews.length;
  const locationReviews = parsed.reviews.filter((r) =>
    rowMatchesLocation(r.external_location_label, location.name, location.csv_aliases)
  );
  stats.skipped_other_location = beforeFilter - locationReviews.length;
  if (locationReviews.length === 0) return stats;

  // Build attribution context: worked entries on dates that have reviews.
  const reviewDates = Array.from(
    new Set(
      locationReviews.map((r) => r.review_date).filter((d): d is string => Boolean(d))
    )
  );
  const ctx: AttributionContext = { workedByDate: new Map() };
  if (reviewDates.length > 0) {
    let from = 0;
    while (true) {
      const { data: page, error: pageErr } = await supabase
        .from("time_entries")
        .select("employee_id, entry_date, in_time, out_time")
        .eq("location_id", location.id)
        .eq("entry_type", "worked")
        .in("entry_date", reviewDates)
        .range(from, from + FETCH_PAGE - 1);
      if (pageErr) {
        stats.failures.push(`fetch worked entries: ${pageErr.message}`);
        break;
      }
      if (!page || page.length === 0) break;
      for (const e of page) {
        const list = ctx.workedByDate.get(e.entry_date as string);
        const item = {
          employee_id: e.employee_id as string,
          in_time: e.in_time as string | null,
          out_time: e.out_time as string | null,
        };
        if (list) list.push(item);
        else ctx.workedByDate.set(e.entry_date as string, [item]);
      }
      if (page.length < FETCH_PAGE) break;
      from += FETCH_PAGE;
    }
  }

  // Pre-fetch existing reviews for insert/update counts (paginated).
  const existingByReviewId = new Map<string, string>();
  {
    let from = 0;
    while (true) {
      const { data: page } = await supabase
        .from("customer_reviews")
        .select("id, external_review_id")
        .eq("location_id", location.id)
        .range(from, from + FETCH_PAGE - 1);
      if (!page || page.length === 0) break;
      for (const r of page) {
        existingByReviewId.set(r.external_review_id as string, r.id as string);
      }
      if (page.length < FETCH_PAGE) break;
      from += FETCH_PAGE;
    }
  }

  // ---- Phase 1: upsert customer_reviews ----
  const reviewPayloads = locationReviews.map((r) => ({
    location_id: location.id,
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
  for (const r of locationReviews) {
    if (existingByReviewId.has(r.external_review_id)) stats.reviews_updated += 1;
    else stats.reviews_inserted += 1;
  }
  await chunkUpsert(
    async (batch: typeof reviewPayloads) =>
      await supabase
        .from("customer_reviews")
        .upsert(batch, { onConflict: "location_id,external_review_id" }),
    reviewPayloads,
    "customer_reviews",
    stats
  );

  // Get IDs back (paginated, date-filtered to the reviews we just imported).
  const reviewIdByExt = new Map<
    string,
    { id: string; date: string | null; datetime: string | null }
  >();
  if (reviewDates.length > 0) {
    let from = 0;
    while (true) {
      const { data: page } = await supabase
        .from("customer_reviews")
        .select("id, external_review_id, review_date, review_datetime")
        .eq("location_id", location.id)
        .in("review_date", reviewDates)
        .range(from, from + FETCH_PAGE - 1);
      if (!page || page.length === 0) break;
      for (const r of page) {
        reviewIdByExt.set(r.external_review_id as string, {
          id: r.id as string,
          date: r.review_date as string | null,
          datetime: (r.review_datetime as string | null) ?? null,
        });
      }
      if (page.length < FETCH_PAGE) break;
      from += FETCH_PAGE;
    }
  }

  // ---- Phase 2: compute attributions ----
  const attributionPayloads: Array<{
    customer_review_id: string;
    employee_id: string;
    attribution_method: "on_shift_at_experienced" | "worked_that_day";
  }> = [];
  const affectedKeys = new Set<string>();
  for (const r of locationReviews) {
    const ref = reviewIdByExt.get(r.external_review_id);
    if (!ref || !ref.date) continue;
    const att = attributeReview(r, ctx);
    if (att.length === 0) {
      stats.attribution_method_counts.none += 1;
      continue;
    }
    for (const a of att) {
      attributionPayloads.push({
        customer_review_id: ref.id,
        employee_id: a.employee_id,
        attribution_method: a.method,
      });
      stats.attribution_method_counts[a.method] += 1;
      const q = quarterOfDate(new Date(ref.date));
      affectedKeys.add(`${a.employee_id}|${q.year}|${q.quarter}`);
    }
  }

  // Replace attributions for imported reviews.
  const importedReviewIds = locationReviews
    .map((r) => reviewIdByExt.get(r.external_review_id)?.id)
    .filter((x): x is string => Boolean(x));
  if (importedReviewIds.length > 0) {
    for (let i = 0; i < importedReviewIds.length; i += 500) {
      const chunk = importedReviewIds.slice(i, i + 500);
      const { error: delErr } = await supabase
        .from("review_attributions")
        .delete()
        .in("customer_review_id", chunk);
      if (delErr) stats.failures.push(`delete attributions: ${delErr.message}`);
    }
  }
  await chunkUpsert(
    async (batch: typeof attributionPayloads) =>
      await supabase.from("review_attributions").insert(batch),
    attributionPayloads,
    "review_attributions",
    stats
  );
  stats.attributions_inserted = attributionPayloads.length;

  // ---- Phase 3: recompute performance ----
  const csWeights = await fetchCustomerServiceWeights(supabase);
  const tisWeights = await fetchTotalImpactWeights(supabase);
  for (const key of affectedKeys) {
    const [employee_id, yearStr, quarterStr] = key.split("|");
    const year = parseInt(yearStr, 10);
    const quarter = parseInt(quarterStr, 10) as Quarter;
    const result = await recomputePerformanceForQuarter(
      supabase,
      employee_id,
      location.id,
      year,
      quarter,
      { csWeights, tisWeights }
    );
    if (result.ok) stats.recomputed += 1;
    else stats.failures.push(`Recompute ${employee_id} ${year}-Q${quarter} @ ${location.name}: ${result.error}`);
  }

  await supabase
    .from("locations")
    .update({ last_data_uploaded_at: new Date().toISOString() })
    .eq("id", location.id);

  return stats;
}
