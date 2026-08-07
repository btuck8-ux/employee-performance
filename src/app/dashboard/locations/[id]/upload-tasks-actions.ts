"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { parseTasksCsv } from "@/lib/task-import";
import {
  runSingleUpload,
  runBulkUpload,
  countTrulyUnmatched,
} from "@/lib/upload-action-kit";
import {
  ingestTasksForLocation,
  newStats,
  type IngestStats,
} from "@/lib/ingest/tasks/ingest-location";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export async function uploadTasksCsvAction(formData: FormData) {
  console.log("[task-import] uploadTasksCsvAction invoked");

  await runSingleUpload({
    formData,
    errorParam: "task_error",
    parse: (text) => {
      const parsed = parseTasksCsv(text);
      console.log(
        `[task-import] parsed ${parsed.rows_in_file} rows -> ${parsed.unique_tasks} unique task instances`
      );
      return parsed;
    },
    fatalParseError: (parsed) =>
      parsed.errors.length > 0 && parsed.tasks.length === 0 ? parsed.errors.join("; ") : null,
    run: async (supabase: Supabase, parsed, location) => {
      const stats = await ingestTasksForLocation(supabase, parsed, location);
      for (const w of parsed.warnings.slice(0, 10)) stats.warnings.push(w);

      console.log(
        `[task-import] ${location.name}: tasks ${stats.tasks_inserted}+${stats.tasks_updated}u, ` +
          `complete=${stats.tasks_complete}, incomplete=${stats.tasks_incomplete}, ` +
          `accountability_rows=${stats.accountability_rows}, ` +
          `ownership_rows=${stats.ownership_rows}, ` +
          `recomputed=${stats.recomputed}, ` +
          `unmatched_owners=${stats.ownership_unmatched.size}, ` +
          `skipped_other=${stats.skipped_other_location}`
      );

      revalidatePath(`/dashboard/locations/${location.id}`);
      revalidatePath("/dashboard/employees");

      const params = new URLSearchParams();
      params.set("task_in", String(stats.tasks_inserted));
      params.set("task_up", String(stats.tasks_updated));
      params.set("task_done", String(stats.tasks_complete));
      params.set("task_undone", String(stats.tasks_incomplete));
      params.set("task_acct", String(stats.accountability_rows));
      params.set("task_owners", String(stats.ownership_rows));
      if (stats.ownership_unmatched.size > 0)
        params.set(
          "task_owners_unmatched",
          Array.from(stats.ownership_unmatched).slice(0, 5).join(", ")
        );
      params.set("task_recomputed", String(stats.recomputed));
      if (stats.skipped_other_location > 0)
        params.set("task_skipped_other_location", String(stats.skipped_other_location));
      if (stats.warnings.length > 0)
        params.set("task_warnings", stats.warnings.slice(0, 3).join(" | "));
      if (stats.failures.length > 0)
        params.set("task_failures", stats.failures.slice(0, 3).join(" | "));
      return params;
    },
  });
}

/**
 * Bulk: fan out a tasks CSV across many locations (scope=client | scope=all).
 * Routes each task by its Location column to the matching location, then runs
 * the per-location ingest. Aggregates counts + per-location breakdown.
 */
export async function uploadTasksCsvBulkAction(formData: FormData) {
  console.log("[task-import] uploadTasksCsvBulkAction invoked");

  await runBulkUpload({
    formData,
    errorParam: "bulk_task_error",
    parse: parseTasksCsv,
    fatalParseError: (parsed) =>
      parsed.errors.length > 0 && parsed.tasks.length === 0 ? parsed.errors.join("; ") : null,
    run: async (supabase: Supabase, parsed, targets, { scope, client_id }) => {
      const aggregated: IngestStats = newStats();
      const perLocation: Array<{
        name: string;
        in: number;
        up: number;
        acct: number;
        owners: number;
        recomputed: number;
      }> = [];

      for (const loc of targets) {
        const stats = await ingestTasksForLocation(supabase, parsed, loc);
        aggregated.tasks_inserted += stats.tasks_inserted;
        aggregated.tasks_updated += stats.tasks_updated;
        aggregated.tasks_complete += stats.tasks_complete;
        aggregated.tasks_incomplete += stats.tasks_incomplete;
        aggregated.accountability_rows += stats.accountability_rows;
        aggregated.ownership_rows += stats.ownership_rows;
        aggregated.skipped_other_location += stats.skipped_other_location;
        aggregated.recomputed += stats.recomputed;
        for (const n of stats.ownership_unmatched) aggregated.ownership_unmatched.add(n);
        aggregated.failures.push(...stats.failures);
        perLocation.push({
          name: loc.name,
          in: stats.tasks_inserted,
          up: stats.tasks_updated,
          acct: stats.accountability_rows,
          owners: stats.ownership_rows,
          recomputed: stats.recomputed,
        });
      }

      // True unmatched: rows whose location_label matches no target name AND no alias.
      const trulyUnmatched = countTrulyUnmatched(
        parsed.tasks.map((t) => t.location_label),
        targets
      );

      for (const loc of targets) revalidatePath(`/dashboard/locations/${loc.id}`);
      revalidatePath("/dashboard/employees");
      if (scope === "client" && client_id) revalidatePath(`/dashboard/clients/${client_id}`);
      revalidatePath("/dashboard/uploads");

      console.log(
        `[task-import] BULK DONE across ${targets.length} locations: ` +
          `tasks=${aggregated.tasks_inserted}+${aggregated.tasks_updated}u, ` +
          `acct=${aggregated.accountability_rows}, owners=${aggregated.ownership_rows}, ` +
          `recomputed=${aggregated.recomputed}, unmatched=${trulyUnmatched}, ` +
          `failures=${aggregated.failures.length}`
      );

      const params = new URLSearchParams();
      params.set("bulk_task_locations", String(targets.length));
      params.set("bulk_task_in", String(aggregated.tasks_inserted));
      params.set("bulk_task_up", String(aggregated.tasks_updated));
      params.set("bulk_task_done", String(aggregated.tasks_complete));
      params.set("bulk_task_undone", String(aggregated.tasks_incomplete));
      params.set("bulk_task_acct", String(aggregated.accountability_rows));
      params.set("bulk_task_owners", String(aggregated.ownership_rows));
      params.set("bulk_task_recomputed", String(aggregated.recomputed));
      params.set("bulk_task_unmatched", String(trulyUnmatched));
      if (aggregated.ownership_unmatched.size > 0)
        params.set(
          "bulk_task_owners_unmatched",
          Array.from(aggregated.ownership_unmatched).slice(0, 5).join(", ")
        );
      const breakdown = perLocation
        .filter((p) => p.in + p.up + p.acct + p.owners > 0)
        .map(
          (p) =>
            `${p.name}: tasks ${p.in}+${p.up}u · acct ${p.acct} · owners ${p.owners} · recomputed ${p.recomputed}`
        )
        .join(" | ");
      if (breakdown) params.set("bulk_task_breakdown", breakdown);
      if (aggregated.failures.length > 0)
        params.set("bulk_task_failures", aggregated.failures.slice(0, 3).join(" | "));
      return params;
    },
  });
}
