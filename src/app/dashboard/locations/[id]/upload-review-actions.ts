"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseCustomerReviewsCsv } from "@/lib/customer-review-import";
import { readCsvFromStorage, deleteCsvFromStorage } from "@/lib/storage-csv";
import {
  ingestReviewsForLocation,
  newStats,
  type IngestStats,
} from "@/lib/ingest/reviews/ingest-location";

export async function uploadCustomerReviewsCsvAction(formData: FormData) {
  console.log("[review-import] uploadCustomerReviewsCsvAction invoked");

  const location_id = String(formData.get("location_id") ?? "");
  const storagePath = String(formData.get("file_path") ?? "");

  if (!location_id) {
    redirect(
      `/dashboard/locations?review_error=${encodeURIComponent("Missing location.")}`
    );
  }
  if (!storagePath) {
    redirect(
      `/dashboard/locations/${location_id}?review_error=${encodeURIComponent("No file uploaded.")}`
    );
  }

  const supabase = await createClient();

  let text: string;
  try {
    text = await readCsvFromStorage(supabase, storagePath);
  } catch (err) {
    await deleteCsvFromStorage(supabase, storagePath);
    redirect(
      `/dashboard/locations/${location_id}?review_error=${encodeURIComponent(
        err instanceof Error ? err.message : "Failed to read uploaded file."
      )}`
    );
  }

  try {
    const parsed = parseCustomerReviewsCsv(text);

    if (parsed.errors.length > 0 && parsed.reviews.length === 0) {
      redirect(
        `/dashboard/locations/${location_id}?review_error=${encodeURIComponent(
          parsed.errors.join("; ")
        )}`
      );
    }

    const { data: locRow } = await supabase
      .from("locations")
      .select("id, name, csv_aliases")
      .eq("id", location_id)
      .single();
    const location = (locRow as { id: string; name: string; csv_aliases: string[] | null } | null) ?? {
      id: location_id,
      name: "",
      csv_aliases: null,
    };

    const stats = await ingestReviewsForLocation(supabase, parsed, location);
    for (const w of parsed.warnings.slice(0, 10)) stats.warnings.push(w);

    revalidatePath(`/dashboard/locations/${location_id}`);
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

    redirect(`/dashboard/locations/${location_id}?${params.toString()}`);
  } finally {
    await deleteCsvFromStorage(supabase, storagePath);
  }
}

/**
 * Bulk: fan out a customer-reviews CSV across many locations
 * (scope=client | scope=all). Each review routes by its
 * external_location_label to the matching location.
 */
export async function uploadCustomerReviewsCsvBulkAction(formData: FormData) {
  console.log("[review-import] uploadCustomerReviewsCsvBulkAction invoked");

  const scope = String(formData.get("scope") ?? "all") as "client" | "all";
  const client_id = scope === "client" ? String(formData.get("client_id") ?? "") : null;
  const storagePath = String(formData.get("file_path") ?? "");

  const redirectBase =
    scope === "client" && client_id
      ? `/dashboard/clients/${client_id}`
      : `/dashboard/uploads`;

  if (!storagePath) {
    redirect(`${redirectBase}?bulk_review_error=${encodeURIComponent("No file uploaded.")}`);
  }

  const supabase = await createClient();

  let text: string;
  try {
    text = await readCsvFromStorage(supabase, storagePath);
  } catch (err) {
    await deleteCsvFromStorage(supabase, storagePath);
    redirect(
      `${redirectBase}?bulk_review_error=${encodeURIComponent(
        err instanceof Error ? err.message : "Failed to read uploaded file."
      )}`
    );
  }

  try {
    const parsed = parseCustomerReviewsCsv(text);

    if (parsed.errors.length > 0 && parsed.reviews.length === 0) {
      redirect(
        `${redirectBase}?bulk_review_error=${encodeURIComponent(parsed.errors.join("; "))}`
      );
    }

    let q = supabase.from("locations").select("id, name, csv_aliases").order("name");
    if (scope === "client" && client_id) q = q.eq("client_id", client_id);
    const { data: targetsRaw } = await q;
    const targets = (targetsRaw ?? []) as Array<{
      id: string;
      name: string;
      csv_aliases: string[] | null;
    }>;
    if (targets.length === 0) {
      redirect(
        `${redirectBase}?bulk_review_error=${encodeURIComponent(
          scope === "client" ? "No locations under this client." : "No locations exist yet."
        )}`
      );
    }

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

    const targetNames = new Set<string>();
    for (const l of targets) {
      targetNames.add(l.name.toLowerCase());
      if (l.csv_aliases) {
        for (const a of l.csv_aliases) {
          if (a) targetNames.add(a.trim().toLowerCase());
        }
      }
    }
    let trulyUnmatched = 0;
    for (const r of parsed.reviews) {
      const lbl = (r.external_location_label ?? "").trim().toLowerCase();
      if (lbl && !targetNames.has(lbl)) trulyUnmatched += 1;
    }

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

    redirect(`${redirectBase}?${params.toString()}`);
  } finally {
    await deleteCsvFromStorage(supabase, storagePath);
  }
}
