"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseTattleCsv } from "@/lib/tattle-import";
import { readCsvFromStorage, deleteCsvFromStorage } from "@/lib/storage-csv";
import {
  ingestTattlesForLocation,
  newStats,
  type IngestStats,
} from "@/lib/ingest/tattle/ingest-location";

export async function uploadTattleCsvAction(formData: FormData) {
  console.log("[tattle-import] uploadTattleCsvAction invoked");

  const location_id = String(formData.get("location_id") ?? "");
  const storagePath = String(formData.get("file_path") ?? "");

  if (!location_id) {
    redirect(`/dashboard/locations?tattle_error=${encodeURIComponent("Missing location.")}`);
  }
  if (!storagePath) {
    redirect(
      `/dashboard/locations/${location_id}?tattle_error=${encodeURIComponent("No file uploaded.")}`
    );
  }

  const supabase = await createClient();

  let text: string;
  try {
    text = await readCsvFromStorage(supabase, storagePath);
  } catch (err) {
    await deleteCsvFromStorage(supabase, storagePath);
    redirect(
      `/dashboard/locations/${location_id}?tattle_error=${encodeURIComponent(
        err instanceof Error ? err.message : "Failed to read uploaded file."
      )}`
    );
  }

  try {
    const parsed = parseTattleCsv(text);
    console.log(
      `[tattle-import] parsed ${parsed.rows_in_file} rows -> ${parsed.unique_surveys} unique surveys`
    );

    if (parsed.errors.length > 0 && parsed.surveys.length === 0) {
      redirect(
        `/dashboard/locations/${location_id}?tattle_error=${encodeURIComponent(parsed.errors.join("; "))}`
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

    const stats = await ingestTattlesForLocation(supabase, parsed, location);
    // Surface parser warnings too (they're independent of per-location stats).
    for (const w of parsed.warnings.slice(0, 10)) stats.warnings.push(w);

    console.log(
      `[tattle-import] ${location.name}: surveys ${stats.surveys_inserted}+${stats.surveys_updated}u, ` +
        `responses=${stats.responses_upserted}, attributions=${stats.attributions_inserted}, ` +
        `recomputed=${stats.recomputed}, skipped_other=${stats.skipped_other_location}`
    );

    revalidatePath(`/dashboard/locations/${location_id}`);
    revalidatePath("/dashboard/employees");

    const params = new URLSearchParams();
    params.set("tattle_in", String(stats.surveys_inserted));
    params.set("tattle_up", String(stats.surveys_updated));
    params.set("tattle_resp", String(stats.responses_upserted));
    params.set("tattle_att", String(stats.attributions_inserted));
    params.set("tattle_onshift", String(stats.attribution_method_counts.on_shift_at_experienced));
    params.set("tattle_workday", String(stats.attribution_method_counts.worked_that_day));
    params.set("tattle_unatt", String(stats.attribution_method_counts.none));
    params.set("tattle_recomputed", String(stats.recomputed));
    if (stats.skipped_other_location > 0)
      params.set("tattle_skipped_other_location", String(stats.skipped_other_location));
    if (stats.warnings.length > 0)
      params.set("tattle_warnings", stats.warnings.slice(0, 3).join(" | "));
    if (stats.failures.length > 0)
      params.set("tattle_failures", stats.failures.slice(0, 3).join(" | "));

    redirect(`/dashboard/locations/${location_id}?${params.toString()}`);
  } finally {
    await deleteCsvFromStorage(supabase, storagePath);
  }
}

/**
 * Bulk: fan out a tattle CSV across many locations (scope=client | scope=all).
 * Each location runs its own filter (by Location column), upsert, attribution,
 * and recompute. Per-location breakdown surfaces in the result banner.
 */
export async function uploadTattleCsvBulkAction(formData: FormData) {
  console.log("[tattle-import] uploadTattleCsvBulkAction invoked");

  const scope = String(formData.get("scope") ?? "all") as "client" | "all";
  const client_id = scope === "client" ? String(formData.get("client_id") ?? "") : null;
  const storagePath = String(formData.get("file_path") ?? "");

  const redirectBase =
    scope === "client" && client_id
      ? `/dashboard/clients/${client_id}`
      : `/dashboard/uploads`;

  if (!storagePath) {
    redirect(`${redirectBase}?bulk_tattle_error=${encodeURIComponent("No file uploaded.")}`);
  }

  const supabase = await createClient();

  let text: string;
  try {
    text = await readCsvFromStorage(supabase, storagePath);
  } catch (err) {
    await deleteCsvFromStorage(supabase, storagePath);
    redirect(
      `${redirectBase}?bulk_tattle_error=${encodeURIComponent(
        err instanceof Error ? err.message : "Failed to read uploaded file."
      )}`
    );
  }

  try {
    const parsed = parseTattleCsv(text);

    if (parsed.errors.length > 0 && parsed.surveys.length === 0) {
      redirect(
        `${redirectBase}?bulk_tattle_error=${encodeURIComponent(parsed.errors.join("; "))}`
      );
    }

    // Resolve target locations (with their csv_aliases for matching).
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
        `${redirectBase}?bulk_tattle_error=${encodeURIComponent(
          scope === "client" ? "No locations under this client." : "No locations exist yet."
        )}`
      );
    }

    // Aggregate stats across all targets.
    const aggregated: IngestStats = newStats();
    const perLocation: Array<{
      name: string;
      surveys_in: number;
      surveys_up: number;
      attributions: number;
      recomputed: number;
    }> = [];

    for (const loc of targets) {
      const stats = await ingestTattlesForLocation(supabase, parsed, loc);
      aggregated.surveys_inserted += stats.surveys_inserted;
      aggregated.surveys_updated += stats.surveys_updated;
      aggregated.responses_upserted += stats.responses_upserted;
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
        surveys_in: stats.surveys_inserted,
        surveys_up: stats.surveys_updated,
        attributions: stats.attributions_inserted,
        recomputed: stats.recomputed,
      });
    }

    // Compute true unmatched count: rows whose location_label matches NO target
    // name AND no target alias.
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
    for (const s of parsed.surveys) {
      const lbl = (s.location_label ?? "").trim().toLowerCase();
      if (lbl && !targetNames.has(lbl)) trulyUnmatched += 1;
    }

    // Revalidate every touched location.
    for (const loc of targets) revalidatePath(`/dashboard/locations/${loc.id}`);
    revalidatePath("/dashboard/employees");
    if (scope === "client" && client_id) revalidatePath(`/dashboard/clients/${client_id}`);
    revalidatePath("/dashboard/uploads");

    console.log(
      `[tattle-import] BULK DONE across ${targets.length} locations: ` +
        `surveys=${aggregated.surveys_inserted}+${aggregated.surveys_updated}u, ` +
        `attributions=${aggregated.attributions_inserted}, recomputed=${aggregated.recomputed}, ` +
        `unmatched=${trulyUnmatched}, failures=${aggregated.failures.length}`
    );

    const params = new URLSearchParams();
    params.set("bulk_tattle_locations", String(targets.length));
    params.set("bulk_tattle_in", String(aggregated.surveys_inserted));
    params.set("bulk_tattle_up", String(aggregated.surveys_updated));
    params.set("bulk_tattle_resp", String(aggregated.responses_upserted));
    params.set("bulk_tattle_att", String(aggregated.attributions_inserted));
    params.set(
      "bulk_tattle_onshift",
      String(aggregated.attribution_method_counts.on_shift_at_experienced)
    );
    params.set(
      "bulk_tattle_workday",
      String(aggregated.attribution_method_counts.worked_that_day)
    );
    params.set("bulk_tattle_unatt", String(aggregated.attribution_method_counts.none));
    params.set("bulk_tattle_recomputed", String(aggregated.recomputed));
    params.set("bulk_tattle_unmatched", String(trulyUnmatched));
    const breakdown = perLocation
      .filter((p) => p.surveys_in + p.surveys_up + p.attributions > 0)
      .map(
        (p) =>
          `${p.name}: surveys ${p.surveys_in}+${p.surveys_up}u · att ${p.attributions} · recomputed ${p.recomputed}`
      )
      .join(" | ");
    if (breakdown) params.set("bulk_tattle_breakdown", breakdown);
    if (aggregated.failures.length > 0)
      params.set("bulk_tattle_failures", aggregated.failures.slice(0, 3).join(" | "));

    redirect(`${redirectBase}?${params.toString()}`);
  } finally {
    await deleteCsvFromStorage(supabase, storagePath);
  }
}
