/**
 * Nightly ingest orchestrator: fan out the 7shifts trio across the crosswalk.
 *
 *   7shifts_time  -> all wired locations (8)
 *   7tasks        -> Colorado stores only (company 185592) — log-only
 *   pos_receipts  -> locations with pos_via_7shifts = true (HOU at launch)
 *
 * Each (source, location) gets its own incremental window: from the last
 * non-error run's window_end (default 7-day lookback on first run) to now.
 * One ingest_runs row per run, success or fail. Locations run sequentially —
 * fine at 8 locations within the function limit (handoff §3), and it keeps
 * Postgres recompute load bounded.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { loadCrosswalk, usesSevenTasks, type LocationCrosswalk } from "./crosswalk";
import {
  startRun,
  finishRun,
  lastSuccessfulWindowEnd,
  type IngestSource,
  type RunOutcome,
} from "./runs";
import { ingestTimePunches } from "./time";
import { ingestReceipts } from "./receipts";
import { ingestTaskSummaries } from "./tasks";
import { maybeSendFailureAlert } from "./alert";

const DEFAULT_LOOKBACK_DAYS = 7;

export interface NightlyIngestSummary {
  started_at: string;
  finished_at: string;
  locations: number;
  runs: number;
  by_status: Record<string, number>;
  alert: { sent: boolean; reason: string };
  outcomes: Array<{
    source: IngestSource;
    location_code: string;
    status: string;
    rows_in: number;
    rows_upserted: number;
    rows_skipped: number;
    error_text: string | null;
  }>;
}

async function windowFor(
  supabase: ReturnType<typeof createAdminClient>,
  source: IngestSource,
  loc: LocationCrosswalk,
  windowEnd: string
): Promise<{ start: string; end: string }> {
  const last = await lastSuccessfulWindowEnd(supabase, source, loc.id);
  const start =
    last ??
    new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return { start, end: windowEnd };
}

export async function runNightlyIngest(): Promise<NightlyIngestSummary> {
  const startedAt = new Date().toISOString();
  const windowEnd = startedAt;
  const supabase = createAdminClient();

  const crosswalk = await loadCrosswalk(supabase);
  const outcomes: RunOutcome[] = [];

  for (const loc of crosswalk) {
    // --- 7shifts_time (all wired locations) ---
    {
      const w = await windowFor(supabase, "7shifts_time", loc, windowEnd);
      const runId = await startRun(supabase, "7shifts_time", loc.id, w.start, w.end);
      const outcome = await ingestTimePunches(supabase, loc, w.start, w.end);
      await finishRun(supabase, runId, outcome);
      outcomes.push(outcome);
    }

    // --- 7tasks (Colorado only; log-only) ---
    if (usesSevenTasks(loc)) {
      const w = await windowFor(supabase, "7tasks", loc, windowEnd);
      const runId = await startRun(supabase, "7tasks", loc.id, w.start, w.end);
      const outcome = await ingestTaskSummaries(loc, w.start, w.end);
      await finishRun(supabase, runId, outcome);
      outcomes.push(outcome);
    }

    // --- pos_receipts (only where the POS integration is live) ---
    if (loc.pos_via_7shifts) {
      const w = await windowFor(supabase, "pos_receipts", loc, windowEnd);
      const runId = await startRun(supabase, "pos_receipts", loc.id, w.start, w.end);
      const outcome = await ingestReceipts(supabase, loc, w.start, w.end);
      await finishRun(supabase, runId, outcome);
      outcomes.push(outcome);
    }
  }

  const alert = await maybeSendFailureAlert(outcomes);

  const byStatus: Record<string, number> = {};
  for (const o of outcomes) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

  return {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    locations: crosswalk.length,
    runs: outcomes.length,
    by_status: byStatus,
    alert,
    outcomes: outcomes.map((o) => ({
      source: o.source,
      location_code: o.location_code,
      status: o.status,
      rows_in: o.rows_in,
      rows_upserted: o.rows_upserted,
      rows_skipped: o.rows_skipped,
      error_text: o.error_text,
    })),
  };
}
