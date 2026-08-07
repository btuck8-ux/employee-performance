"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { parseCustomerReviewsCsv } from "@/lib/customer-review-import";
import {
  runSingleUpload,
  runBulkUpload,
  countTrulyUnmatched,
} from "@/lib/upload-action-kit";
import {
  ingestReviewsForLocation,
  newStats,
  type IngestStats,
} from "@/lib/ingest/reviews/ingest-location";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export async function uploadCustomerReviewsCsvAction(formData: FormData) {
  console.log("[review-import] uploadCustomerReviewsCsvAction invoked");

  await runSingleUpload({
    formData,
    errorParam: "review_error",
    parse: parseCustomerReviewsCsv,
    fatalParseError: (parsed) =>
      parsed.errors.length > 0 && parsed.reviews.length === 0 ? parsed.errors.join("; ") : null,
    run: async (supabase: Supabase, parsed, location) => {
      const stats = await ingestReviewsForLocation(supabase, parsed, location);
      for (const w of parsed.warnings.slice(0, 10)) stats.warnings.push(w);

      revalidatePath(`/dashboard/locations/${location.id}`);
      revalidatePath("/dashboard/employees");

      const params = new URLSearchParams();
      params.set("review_in", String(stats.reviews_inserted));
      params.set("review_up", String(stats.reviews_updated));
      params.set("review_att", String(stats.attributions_inserted));
      params.set("review_onshift", String(stats.attribution_method_counts.on_shift_at_experienced));
      params.set("review_workday", String(stats.attribution_method_counts.worked_that_day));
      params.set("review_unatt", String(stats.attribution_method_counts.none));
      params.set("review_recomputed", String(stats.recomputed));
      if (stats.skipped_other_location > 0)
        params.set("review_skipped_other_location", String(stats.skipped_other_location));
      if (stats.warnings.length > 0)
        params.set("review_warnings", stats.warnings.slice(0, 3).join(" | "));
      if (stats.failures.length > 0)
        params.set("review_failures", stats.failures.slice(0, 3).join(" | "));
      return params;
    },
  });
}

/**
 * Bulk: fan out a customer-reviews CSV across many locations
 * (scope=client | scope=all). Each review routes by its
 * external_location_label to the matching location.
 */
export async function uploadCustomerReviewsCsvBulkAction(formData: FormData) {
  console.log("[review-import] uploadCustomerReviewsCsvBulkAction invoked");

  await runBulkUpload({
    formData,
    errorParam: "bulk_review_error",
    parse: parseCustomerReviewsCsv,
    fatalParseError: (parsed) =>
      parsed.errors.length > 0 && parsed.reviews.length === 0 ? parsed.errors.join("; ") : null,
    run: async (supabase: Supabase, parsed, targets, { scope, client_id }) => {
      const aggregated: IngestStats = newStats();
      const perLocation: Array<{
        name: string;
        in: number;
        up: number;
        att: number;
        recomputed: number;
      }> = [];

      for (const loc of targets) {
        const stats = await ingestReviewsForLocation(supabase, parsed, loc);
        aggregated.reviews_inserted += stats.reviews_inserted;
        aggregated.reviews_updated += stats.reviews_updated;
        aggregated.attributions_inserted += stats.attributions_inserted;
        aggregated.attribution_method_counts.on_shift_at_experienced +=
          stats.attribution_method_counts.on_shift_at_experienced;
        aggregated.attribution_method_counts.worked_that_day +=
          stats.attribution_method_counts.worked_that_day;
        aggregated.attribution_method_counts.none += stats.attribution_method_counts.none;
        aggregated.skipped_other_location += stats.skipped_other_location;
        aggregated.recomputed += stats.recomputed;
        aggregated.failures.push(...stats.failures);
        perLocation.push({
          name: loc.name,
          in: stats.reviews_inserted,
          up: stats.reviews_updated,
          att: stats.attributions_inserted,
          recomputed: stats.recomputed,
        });
      }

      const trulyUnmatched = countTrulyUnmatched(
        parsed.reviews.map((r) => r.external_location_label),
        targets
      );

      for (const loc of targets) revalidatePath(`/dashboard/locations/${loc.id}`);
      revalidatePath("/dashboard/employees");
      if (scope === "client" && client_id) revalidatePath(`/dashboard/clients/${client_id}`);
      revalidatePath("/dashboard/uploads");

      const params = new URLSearchParams();
      params.set("bulk_review_locations", String(targets.length));
      params.set("bulk_review_in", String(aggregated.reviews_inserted));
      params.set("bulk_review_up", String(aggregated.reviews_updated));
      params.set("bulk_review_att", String(aggregated.attributions_inserted));
      params.set(
        "bulk_review_onshift",
        String(aggregated.attribution_method_counts.on_shift_at_experienced)
      );
      params.set(
        "bulk_review_workday",
        String(aggregated.attribution_method_counts.worked_that_day)
      );
      params.set("bulk_review_unatt", String(aggregated.attribution_method_counts.none));
      params.set("bulk_review_recomputed", String(aggregated.recomputed));
      params.set("bulk_review_unmatched", String(trulyUnmatched));
      const breakdown = perLocation
        .filter((p) => p.in + p.up + p.att > 0)
        .map(
          (p) =>
            `${p.name}: reviews ${p.in}+${p.up}u · att ${p.att} · recomputed ${p.recomputed}`
        )
        .join(" | ");
      if (breakdown) params.set("bulk_review_breakdown", breakdown);
      if (aggregated.failures.length > 0)
        params.set("bulk_review_failures", aggregated.failures.slice(0, 3).join(" | "));
      return params;
    },
  });
}
