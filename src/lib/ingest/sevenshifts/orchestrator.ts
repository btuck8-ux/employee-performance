/**
 * Nightly ingest orchestrator: fan out the 7shifts trio across the crosswalk.
 *
 *   7shifts_time  -> all wired locations (8)
 *   pos_receipts  -> locations with pos_via_7shifts = true (HOU at launch)
 *
 * NOTE: the old log-only `7tasks` step (aggregate task_list_daily_summary) was
 * retired once the guest-feedback harvester began writing REAL per-employee
 * 7Tasks rows under the same source='7tasks' key. Running both would double-log
 * an ingest_runs row per CO store each night and corrupt the harvester's
 * lastSuccessfulWindowEnd incremental-window math on that (source, location).
 * Per-employee 7Tasks now lives entirely in /api/cron/harvest-guest-feedback.
 *
 * Each (source, location) gets its own incremental window: from the last
 * non-error run's window_end (default 7-day lookback on first run) to now.
 * One ingest_runs row per run, success or fail. Locations run sequentially —
 * fine at 8 locations within the function limit (handoff §3), and it keeps
 * Postgres recompute load bounded.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { loadCrosswalk, type LocationCrosswalk } from "./crosswalk";
import {
  startRun,
  finishRun,
  lastSuccessfulWindowEnd,
  type IngestSource,
  type RunOutcome,
} from "./runs";
import { ingestTimePunches } from "./time";
import { ingestReceipts } from "./receipts";
import { ingestSevenShiftsShifts } from "./shifts";
import { maybeSendFailureAlert } from "./alert";
import { emptyStreakReasons } from "./streak";
import {
  quarterWorkedCoverage,
  coverageReasons,
  quarterCoverageWindow,
  type CoverageReport,
} from "./coverage";
import { resolveIdentities, type IdentityResolutionSummary } from "./identities";
import { currentQuarter } from "@/lib/quarter";

/**
 * First-run backfill floor: the start of the current calendar quarter, as an
 * ISO timestamp. Replaces the old 7-day default so a location's very first run
 * — or a cron that comes up mid-quarter — backfills the whole quarter instead
 * of leaving a silent pre-cron hole (handoff §3: HOU had 2 of 31 May days, CO
 * stores ~9-10 of ~26). Only the first window is widened; once a location has a
 * successful run, windowFor() resumes from lastSuccessfulWindowEnd as before, so
 * this never re-pulls the quarter on subsequent nights.
 */
function firstRunFloor(): string {
  return currentQuarter().periodStart.toISOString();
}

export interface NightlyIngestSummary {
  started_at: string;
  finished_at: string;
  locations: number;
  runs: number;
  by_status: Record<string, number>;
  identities: IdentityResolutionSummary;
  alert: { sent: boolean; reason: string };
  coverage: CoverageReport[];
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
  const start = last ?? firstRunFloor();
  return { start, end: windowEnd };
}

export async function runNightlyIngest(): Promise<NightlyIngestSummary> {
  const startedAt = new Date().toISOString();
  const windowEnd = startedAt;
  const supabase = createAdminClient();

  const crosswalk = await loadCrosswalk(supabase);

  // Resolve employee identities first (idempotent email bridge) so the
  // time/receipt fetchers can join punches/receipts to employees by
  // seven_shifts_user_id. Self-healing: new hires bridge on the next run.
  const identities = await resolveIdentities(supabase, crosswalk);
  console.log(
    `[nightly-ingest] identities: matched ${identities.total_matched} new; errors ${identities.errors.length}`
  );

  const outcomes: RunOutcome[] = [];

  for (const loc of crosswalk) {
    // --- 7shifts_time (only locations whose actuals come from 7shifts) ---
    // Locations on another actuals source (e.g. NOLA -> CAKE, migration 033)
    // skip this block: their 7shifts time pull is a silent no-op that would
    // otherwise log `empty` nightly, and routing it here prevents double-sourcing
    // time_entries. Scheduling is unaffected — only worked actuals are gated.
    if (loc.actuals_source === "7shifts") {
      const w = await windowFor(supabase, "7shifts_time", loc, windowEnd);
      const runId = await startRun(supabase, "7shifts_time", loc.id, w.start, w.end);
      const outcome = await ingestTimePunches(supabase, loc, w.start, w.end);
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

  // --- 7shifts_shifts: EPD's direct scheduled-shift feed (2026-08-23 §4-H).
  // ALL crosswalked locations (NOLA included — CAKE owns its worked actuals,
  // 7shifts still owns its schedule), one API pull per company, per-location
  // ingest_runs rows managed inside. Parallel to cp_schedule, never
  // time_entries; the probe measured ~10s for the full window across all
  // three companies, comfortably inside the cron budget.
  outcomes.push(...(await ingestSevenShiftsShifts(supabase, crosswalk)));

  // Per-location empty-streak guard: catch a single location drifting `empty`
  // night after night even while the same source has data elsewhere (the NOLA
  // failure mode decideAlert() missed). Needs ingest_runs history, so it runs
  // here and feeds its reasons into the alert.
  const streakReasons = await emptyStreakReasons(supabase, outcomes);

  // Worked-day coverage health check: flag any 7shifts location whose distinct
  // worked days this quarter fall below 80% of elapsed days — the quarter-wide
  // hole class the firstRunFloor guard prevents going forward but cannot heal
  // retroactively (handoff §3/§4). Reasons join the same alert.
  const coverageWindow = quarterCoverageWindow(currentQuarter(), new Date());
  const coverage = await quarterWorkedCoverage(supabase, crosswalk, coverageWindow);
  const alert = await maybeSendFailureAlert(outcomes, [
    ...streakReasons,
    ...coverageReasons(coverage, coverageWindow.label),
  ]);

  const byStatus: Record<string, number> = {};
  for (const o of outcomes) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

  return {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    locations: crosswalk.length,
    runs: outcomes.length,
    by_status: byStatus,
    identities,
    alert,
    coverage,
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
