"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { parseTattleCsv } from "@/lib/tattle-import";
import {
  runSingleUpload,
  runBulkUpload,
  countTrulyUnmatched,
} from "@/lib/upload-action-kit";
import {
  ingestTattlesForLocation,
  newStats,
  type IngestStats,
} from "@/lib/ingest/tattle/ingest-location";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export async function uploadTattleCsvAction(formData: FormData) {
  console.log("[tattle-import] uploadTattleCsvAction invoked");

  await runSingleUpload({
    formData,
    errorParam: "tattle_error",
    parse: (text) => {
      const parsed = parseTattleCsv(text);
      console.log(
        `[tattle-import] parsed ${parsed.rows_in_file} rows -> ${parsed.unique_surveys} unique surveys`
      );
      return parsed;
    },
    fatalParseError: (parsed) =>
      parsed.errors.length > 0 && parsed.surveys.length === 0 ? parsed.errors.join("; ") : null,
    run: async (supabase: Supabase, parsed, location) => {
      const stats = await ingestTattlesForLocation(supabase, parsed, location);
      // Surface parser warnings too (they're independent of per-location stats).
      for (const w of parsed.warnings.slice(0, 10)) stats.warnings.push(w);

      console.log(
        `[tattle-import] ${location.name}: surveys ${stats.surveys_inserted}+${stats.surveys_updated}u, ` +
          `responses=${stats.responses_upserted}, attributions=${stats.attributions_inserted}, ` +
          `recomputed=${stats.recomputed}, skipped_other=${stats.skipped_other_location}`
      );

      revalidatePath(`/dashboard/locations/${location.id}`);
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
      return params;
    },
  });
}

/**
 * Bulk: fan out a tattle CSV across many locations (scope=client | scope=all).
 * Each location runs its own filter (by Location column), upsert, attribution,
 * and recompute. Per-location breakdown surfaces in the result banner.
 */
export async function uploadTattleCsvBulkAction(formData: FormData) {
  console.log("[tattle-import] uploadTattleCsvBulkAction invoked");

  await runBulkUpload({
    formData,
    errorParam: "bulk_tattle_error",
    parse: parseTattleCsv,
    fatalParseError: (parsed) =>
      parsed.errors.length > 0 && parsed.surveys.length === 0 ? parsed.errors.join("; ") : null,
    run: async (supabase: Supabase, parsed, targets, { scope, client_id }) => {
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

      // Compute true unmatched count: rows whose location_label matches NO
      // target name AND no target alias.
      const trulyUnmatched = countTrulyUnmatched(
        parsed.surveys.map((s) => s.location_label),
        targets
      );

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
      return params;
    },
  });
}
