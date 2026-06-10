import type { AdminClient } from "./crosswalk";

export type IngestSource =
  | "7shifts_time"
  | "7tasks"
  | "pos_receipts"
  | "cake_timesheets"
  | "tattle"
  | "reviews";
export type IngestStatus = "running" | "success" | "empty" | "error";

export interface FinishRunInput {
  status: IngestStatus;
  rows_in?: number;
  rows_upserted?: number;
  rows_skipped?: number;
  detail?: Record<string, unknown> | null;
  error_text?: string | null;
}

/**
 * A normalized summary returned by every fetcher so the orchestrator can both
 * finish the ingest_runs row and roll the run into the failure email.
 */
export interface RunOutcome {
  source: IngestSource;
  location_id: string;
  location_code: string;
  status: IngestStatus;
  rows_in: number;
  rows_upserted: number;
  rows_skipped: number;
  detail: Record<string, unknown> | null;
  error_text: string | null;
  window_start: string | null;
  window_end: string | null;
}

/** Insert a 'running' row and return its id. */
export async function startRun(
  supabase: AdminClient,
  source: IngestSource,
  locationId: string,
  windowStart: string | null,
  windowEnd: string | null
): Promise<string | null> {
  const { data, error } = await supabase
    .from("ingest_runs")
    .insert({
      source,
      location_id: locationId,
      status: "running",
      window_start: windowStart,
      window_end: windowEnd,
    })
    .select("id")
    .single();
  if (error) {
    console.error(`[ingest/runs] failed to start run ${source}/${locationId}:`, error.message);
    return null;
  }
  return data.id as string;
}

/** Finalize a run row with its terminal status + counts + detail. */
export async function finishRun(
  supabase: AdminClient,
  runId: string | null,
  input: FinishRunInput
): Promise<void> {
  if (!runId) return;
  const { error } = await supabase
    .from("ingest_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: input.status,
      rows_in: input.rows_in ?? 0,
      rows_upserted: input.rows_upserted ?? 0,
      rows_skipped: input.rows_skipped ?? 0,
      detail: input.detail ?? null,
      error_text: input.error_text ?? null,
    })
    .eq("id", runId);
  if (error) {
    console.error(`[ingest/runs] failed to finish run ${runId}:`, error.message);
  }
}

/**
 * The high-water mark for incremental pulls: the latest `window_end` of a prior
 * non-error run for this (source, location). Returns null on the first ever run
 * (caller falls back to the default lookback).
 */
export async function lastSuccessfulWindowEnd(
  supabase: AdminClient,
  source: IngestSource,
  locationId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("ingest_runs")
    .select("window_end")
    .eq("source", source)
    .eq("location_id", locationId)
    .in("status", ["success", "empty"])
    .not("window_end", "is", null)
    .order("window_end", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(`[ingest/runs] lastSuccessfulWindowEnd lookup failed (${source}/${locationId}):`, error.message);
    return null;
  }
  return (data?.window_end as string | undefined) ?? null;
}
