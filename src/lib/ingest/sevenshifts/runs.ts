import type { AdminClient } from "./crosswalk";
import { countRecomputeFailures } from "../recompute-failure-count.ts";

export type IngestSource =
  | "7shifts_time"
  | "7tasks"
  | "pos_receipts"
  | "cake_timesheets"
  | "tattle"
  | "reviews"
  | "toast_sales"
  | "culture_pulse"
  | "toast_kitchen"
  | "cp_schedule"
  | "7shifts_shifts"
  | "toast_labor"
  | "auto_mint";
/**
 * W7 (MASTER sprint): `partial` is a first-class terminal status — a run
 * that durably wrote at least one row AND terminally failed at least one
 * unit of its own work plan within the run. The rule distinguishing it:
 *   error   = nothing trustworthy was completed (the run aborted);
 *   empty   = the whole window was observed and held nothing to write;
 *   success = the whole work plan completed (deliberate skips included);
 *   partial = real rows landed AND part of the plan terminally failed.
 * RULED, both-or-neither: partial ALERTS and does NOT advance
 * lastSuccessfulWindowEnd. The forbidden combination is "doesn't alert but
 * does advance the window."
 *
 * INERT until activation (W7 gate 5b): no producer emits `partial` unless
 * INGEST_PARTIAL_STATUS_ENABLED === "1" — an explicit runtime flag, not a
 * scheduling assumption. The DB constraint must be widened (mig 095, G4)
 * BEFORE the flag is ever set; the type widening below causes no producer
 * to emit anything.
 */
export type IngestStatus = "running" | "success" | "empty" | "error" | "partial";

/** The single activation switch for the changed feed behaviour. */
export function partialStatusEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.INGEST_PARTIAL_STATUS_ENABLED === "1";
}

/**
 * The one policy point producers route a proposed terminal status through.
 * Flag off (today): returns the proposed status byte-identically. Flag on:
 * a run that upserted rows AND carries terminal in-run failures
 * (recompute_failure_count > 0 in its detail) becomes `partial`. `error`
 * and `empty` are never rewritten; a success with zero failures never is.
 */
export function applyPartialPolicy<
  T extends {
    status: IngestStatus;
    rows_upserted: number;
    detail: Record<string, unknown> | null;
  },
>(outcome: T, env: NodeJS.ProcessEnv = process.env): T {
  if (!partialStatusEnabled(env)) return outcome;
  if (outcome.status !== "success") return outcome;
  // Counting rides the SHARED counter (recompute-failure-count.ts) — the
  // same detail-not-error_text rule the sweep and alerts use, so the
  // policy can never disagree with them on what counts as a failure
  // (Codex CP3: an inline Number() conversion handled string counts
  // differently from the counter).
  const { count } = countRecomputeFailures(outcome.detail);
  if (outcome.rows_upserted > 0 && count > 0) {
    return { ...outcome, status: "partial" };
  }
  return outcome;
}

export interface FinishRunInput {
  status: IngestStatus;
  rows_in?: number;
  rows_upserted?: number;
  rows_skipped?: number;
  detail?: Record<string, unknown> | null;
  error_text?: string | null;
  /**
   * Optional high-water-mark correction. A fetcher that pulled LESS than the
   * window startRun recorded (e.g. the Toast feed's per-run business-date cap)
   * passes the clamped end here so lastSuccessfulWindowEnd resumes from what
   * was actually pulled, not from the aspirational window.
   */
  window_end?: string | null;
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
  // Nullable since 2026-08-31: ingest_runs.location_id has always been
  // nullable in the DB, and the auto-mint job is a single estate-wide scan
  // rather than a per-store fan-out, so it logs ONE run row with no location.
  // Every pre-existing caller still passes a real id.
  locationId: string | null,
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
  const update: Record<string, unknown> = {
    finished_at: new Date().toISOString(),
    status: input.status,
    rows_in: input.rows_in ?? 0,
    rows_upserted: input.rows_upserted ?? 0,
    rows_skipped: input.rows_skipped ?? 0,
    detail: input.detail ?? null,
    error_text: input.error_text ?? null,
  };
  if (input.window_end !== undefined && input.window_end !== null) {
    update.window_end = input.window_end;
  }
  const { error } = await supabase
    .from("ingest_runs")
    .update(update)
    .eq("id", runId);
  if (error) {
    console.error(`[ingest/runs] failed to finish run ${runId}:`, error.message);
  }
}

/**
 * The high-water mark for incremental pulls: the latest `window_end` of a prior
 * non-error run for this (source, location). Returns null on the first ever run
 * (caller falls back to the default lookback).
 *
 * `opts.windowEndAtLeast` filters to runs whose window_end reaches a floor —
 * used by first-run detection so a HISTORICAL operator backfill (whose
 * window_end predates the floor by construction) cannot masquerade as the
 * feed's first real run and suppress the floor widening (Codex 2026-08-25).
 */
export async function lastSuccessfulWindowEnd(
  supabase: AdminClient,
  source: IngestSource,
  locationId: string,
  opts?: { windowEndAtLeast?: string }
): Promise<string | null> {
  let query = supabase
    .from("ingest_runs")
    .select("window_end")
    .eq("source", source)
    .eq("location_id", locationId)
    .in("status", ["success", "empty"])
    .not("window_end", "is", null);
  if (opts?.windowEndAtLeast) {
    query = query.gte("window_end", opts.windowEndAtLeast);
  }
  const { data, error } = await query
    .order("window_end", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(`[ingest/runs] lastSuccessfulWindowEnd lookup failed (${source}/${locationId}):`, error.message);
    return null;
  }
  return (data?.window_end as string | undefined) ?? null;
}
