/**
 * Shared per-location 7Tasks ingest loop: one parsed Tasks-report CSV fanned
 * out over a list of EPD locations, with an ingest_runs row (source '7tasks')
 * per store. The CSV `Location` column routes stores — a non-matching store
 * just yields skipped_other_location.
 *
 * Extracted from harvest.ts Source C. Sole entry point today: the nightly
 * guest-feedback harvest (guest-feedback/harvest.ts), which pulls the Tasks
 * report via the public 7shifts API (tasks-api-source.ts).
 */

import {
  startRun,
  finishRun,
  type IngestStatus,
  type RunOutcome,
} from "../sevenshifts/runs";
import type { AdminClient } from "../sevenshifts/crosswalk";
import { ingestTasksForLocation } from "./ingest-location";
import type { TaskImportResult } from "@/lib/task-import";

export interface TasksTarget {
  id: string;
  name: string;
  location_code: string;
  csv_aliases: string[] | null;
}

function statusFromCounts(touched: number, failures: string[]): IngestStatus {
  if (failures.length > 0) return "error";
  return touched > 0 ? "success" : "empty";
}

/**
 * Ingest one parsed report for each target. `windowStartIsoByLocation` maps
 * location id -> the ISO window_start recorded on its run row (per-location
 * incremental windows in the harvest; the CSV's own date range in the route).
 */
export async function ingestParsedTasksForTargets(
  supabase: AdminClient,
  parsed: TaskImportResult,
  targets: TasksTarget[],
  windowStartIsoByLocation: Map<string, string>,
  endIso: string
): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = [];
  for (const loc of targets) {
    const windowStartIso = windowStartIsoByLocation.get(loc.id) ?? endIso;
    const runId = await startRun(supabase, "7tasks", loc.id, windowStartIso, endIso);
    const stats = await ingestTasksForLocation(supabase, parsed, loc);
    const touched = stats.tasks_inserted + stats.tasks_updated;
    const status = statusFromCounts(touched, stats.failures);
    await finishRun(supabase, runId, {
      status,
      rows_in: touched,
      rows_upserted: touched,
      rows_skipped: stats.skipped_other_location,
      detail: {
        tasks_inserted: stats.tasks_inserted,
        tasks_updated: stats.tasks_updated,
        tasks_complete: stats.tasks_complete,
        tasks_incomplete: stats.tasks_incomplete,
        accountability_rows: stats.accountability_rows,
        ownership_rows: stats.ownership_rows,
        ownership_unmatched: Array.from(stats.ownership_unmatched),
        recomputed: stats.recomputed,
        warnings: stats.warnings,
        failures: stats.failures,
      },
      error_text:
        stats.failures.length > 0 ? stats.failures.slice(0, 3).join(" | ") : null,
    });
    outcomes.push({
      source: "7tasks",
      location_id: loc.id,
      location_code: loc.location_code,
      status,
      rows_in: touched,
      rows_upserted: touched,
      rows_skipped: stats.skipped_other_location,
      detail: null,
      error_text: stats.failures[0] ?? null,
      window_start: windowStartIso,
      window_end: endIso,
    });
  }
  return outcomes;
}
