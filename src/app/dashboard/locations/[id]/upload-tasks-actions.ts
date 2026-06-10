"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseTasksCsv } from "@/lib/task-import";
import { readCsvFromStorage, deleteCsvFromStorage } from "@/lib/storage-csv";
import {
  ingestTasksForLocation,
  newStats,
  type IngestStats,
} from "@/lib/ingest/tasks/ingest-location";

export async function uploadTasksCsvAction(formData: FormData) {
  console.log("[task-import] uploadTasksCsvAction invoked");

  const location_id = String(formData.get("location_id") ?? "");
  const storagePath = String(formData.get("file_path") ?? "");

  if (!location_id) {
    redirect(`/dashboard/locations?task_error=${encodeURIComponent("Missing location.")}`);
  }
  if (!storagePath) {
    redirect(
      `/dashboard/locations/${location_id}?task_error=${encodeURIComponent("No file uploaded.")}`
    );
  }

  const supabase = await createClient();

  let text: string;
  try {
    text = await readCsvFromStorage(supabase, storagePath);
  } catch (err) {
    await deleteCsvFromStorage(supabase, storagePath);
    redirect(
      `/dashboard/locations/${location_id}?task_error=${encodeURIComponent(
        err instanceof Error ? err.message : "Failed to read uploaded file."
      )}`
    );
  }

  try {
    const parsed = parseTasksCsv(text);
    console.log(
      `[task-import] parsed ${parsed.rows_in_file} rows -> ${parsed.unique_tasks} unique task instances`
    );
    if (parsed.errors.length > 0 && parsed.tasks.length === 0) {
      redirect(
        `/dashboard/locations/${location_id}?task_error=${encodeURIComponent(
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

    revalidatePath(`/dashboard/locations/${location_id}`);
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

    redirect(`/dashboard/locations/${location_id}?${params.toString()}`);
  } finally {
    await deleteCsvFromStorage(supabase, storagePath);
  }
}

/**
 * Bulk: fan out a tasks CSV across many locations (scope=client | scope=all).
 * Routes each task by its Location column to the matching location, then runs
 * the per-location ingest. Aggregates counts + per-location breakdown.
 */
export async function uploadTasksCsvBulkAction(formData: FormData) {
  console.log("[task-import] uploadTasksCsvBulkAction invoked");

  const scope = String(formData.get("scope") ?? "all") as "client" | "all";
  const client_id = scope === "client" ? String(formData.get("client_id") ?? "") : null;
  const storagePath = String(formData.get("file_path") ?? "");

  const redirectBase =
    scope === "client" && client_id
      ? `/dashboard/clients/${client_id}`
      : `/dashboard/uploads`;

  if (!storagePath) {
    redirect(`${redirectBase}?bulk_task_error=${encodeURIComponent("No file uploaded.")}`);
  }

  const supabase = await createClient();

  let text: string;
  try {
    text = await readCsvFromStorage(supabase, storagePath);
  } catch (err) {
    await deleteCsvFromStorage(supabase, storagePath);
    redirect(
      `${redirectBase}?bulk_task_error=${encodeURIComponent(
        err instanceof Error ? err.message : "Failed to read uploaded file."
      )}`
    );
  }

  try {
    const parsed = parseTasksCsv(text);

    if (parsed.errors.length > 0 && parsed.tasks.length === 0) {
      redirect(
        `${redirectBase}?bulk_task_error=${encodeURIComponent(parsed.errors.join("; "))}`
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
        `${redirectBase}?bulk_task_error=${encodeURIComponent(
          scope === "client" ? "No locations under this client." : "No locations exist yet."
        )}`
      );
    }

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
    for (const t of parsed.tasks) {
      const lbl = (t.location_label ?? "").trim().toLowerCase();
      if (lbl && !targetNames.has(lbl)) trulyUnmatched += 1;
    }

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

    redirect(`${redirectBase}?${params.toString()}`);
  } finally {
    await deleteCsvFromStorage(supabase, storagePath);
  }
}
