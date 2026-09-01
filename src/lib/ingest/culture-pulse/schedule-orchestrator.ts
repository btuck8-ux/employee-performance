/**
 * CP→EPD schedule sync orchestrator: fan the scheduled-shift pull out over all
 * 8 stores — NOLA included: CP schedules it even though its worked actuals
 * ride the CAKE feed (kickoff-ui-rbac-c-brand-2026-08-14.md §3).
 *
 * Window semantics: rolling [today − 14d, today + 21d]. The lookback catches
 * late schedule edits; the lookahead lands future shifts for the employee
 * profile's "upcoming" panel (they are excluded from attendance math by
 * scheduledScoredThrough until the dates pass). A location's FIRST run widens
 * the lookback to the 2026-06-01 backfill floor — the month the CSV-era
 * scheduled uploads stopped — so the first nightly IS the Q2/Q3 backfill
 * (mirrors the sevenshifts firstRunFloor pattern). Idempotent upserts make
 * the nightly overlap free.
 *
 * Alerting: unlike the weekly-cadence survey feed, schedules are
 * forward-looking daily data — every store should have rows in a 5-week
 * window every night. So this source DOES join the per-location empty-streak
 * guard (streak.ts): a store going empty 3+ nights is exactly the
 * schedules-went-quiet failure that created the Jun–Aug scheduled gap.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  startRun,
  finishRun,
  lastSuccessfulWindowEnd,
  type RunOutcome,
} from "../sevenshifts/runs";
import { maybeSendFailureAlert } from "../sevenshifts/alert";
import { emptyStreakReasons } from "../sevenshifts/streak";
import { loadCpSyncLocations } from "./crosswalk";
import { createCpClient } from "./client";
import { fetchCpScheduleRows } from "./schedule-fetch";
import { ingestCpSchedulesForLocation } from "./schedule-ingest";

const LOOKBACK_DAYS = 14;
const LOOKAHEAD_DAYS = 21;

/** First-run backfill floor: where the CSV-era scheduled uploads stopped. */
export const SCHEDULE_BACKFILL_FLOOR = "2026-06-01";

export interface CpScheduleSyncSummary {
  started_at: string;
  finished_at: string;
  locations: number;
  runs: number;
  by_status: Record<string, number>;
  alert: { sent: boolean; reason: string };
  outcomes: Array<{
    location_code: string;
    status: string;
    rows_in: number;
    rows_upserted: number;
    rows_skipped: number;
    error_text: string | null;
  }>;
}

export interface CpScheduleSyncOptions {
  /** Restrict to one store (location_code); default all 8. */
  locationCode?: string;
  /** Override the window start (YYYY-MM-DD) — operator backfill. */
  since?: string;
}

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function runCpScheduleSync(
  options: CpScheduleSyncOptions = {}
): Promise<CpScheduleSyncSummary> {
  const startedAt = new Date().toISOString();
  const supabase = createAdminClient();
  const cp = createCpClient();

  let locations = await loadCpSyncLocations(supabase);
  if (options.locationCode) {
    locations = locations.filter((l) => l.location_code === options.locationCode);
    if (locations.length === 0) {
      throw new Error(`No CP-synced location with code "${options.locationCode}".`);
    }
  }

  const untilDate = isoDateOffset(LOOKAHEAD_DAYS);
  const outcomes: RunOutcome[] = [];

  for (const loc of locations) {
    // First run for a location backfills from the floor; later runs roll.
    let sinceDate = options.since;
    if (!sinceDate) {
      const prior = await lastSuccessfulWindowEnd(supabase, "cp_schedule", loc.id);
      sinceDate = prior ? isoDateOffset(-LOOKBACK_DAYS) : SCHEDULE_BACKFILL_FLOOR;
    }

    const windowStart = `${sinceDate}T00:00:00.000Z`;
    const windowEnd = `${untilDate}T23:59:59.999Z`;
    const runId = await startRun(supabase, "cp_schedule", loc.id, windowStart, windowEnd);

    const outcome: RunOutcome = {
      source: "cp_schedule",
      location_id: loc.id,
      location_code: loc.location_code,
      status: "running",
      rows_in: 0,
      rows_upserted: 0,
      rows_skipped: 0,
      detail: null,
      error_text: null,
      window_start: windowStart,
      window_end: windowEnd,
    };
    try {
      const rows = await fetchCpScheduleRows(cp, loc.cp_location_id, sinceDate, untilDate);
      const stats = await ingestCpSchedulesForLocation(supabase, loc, rows, {
        sinceDate,
        untilDate,
      });

      outcome.rows_in = rows.length;
      outcome.rows_upserted = stats.entries_upserted;
      // Row-level counts — the deduped label lists undercount (Codex #4).
      outcome.rows_skipped =
        stats.unmatched_rows + stats.inactive_rows + stats.skipped_no_start;
      outcome.detail = {
        entries_upserted: stats.entries_upserted,
        out_of_window: stats.out_of_window,
        employees_touched: stats.employees_touched,
        quarters_recomputed: stats.quarters_recomputed,
        records_recomputed: stats.records_recomputed,
        resolved_by_code: stats.resolved_by_code,
        resolved_by_seven_shifts_id: stats.resolved_by_seven_shifts_id,
        unmatched: stats.unmatched.slice(0, 20),
        unmatched_rows: stats.unmatched_rows,
        inactive_skipped: stats.inactive_skipped.slice(0, 20),
        inactive_rows: stats.inactive_rows,
        skipped_no_start: stats.skipped_no_start,
        multi_shift_days: stats.multi_shift_days,
        recompute_failures: stats.failures.slice(0, 20),
      };
      outcome.status = stats.entries_upserted > 0 ? "success" : "empty";

      // ⚠️ A GREEN RUN MUST NOT CONCEAL LOSS.
      // Until 2026-08-31 a run reported status='success' while silently
      // skipping rows: LONGM ran two consecutive nights at
      // `success · upserted 98 · skipped 2 · unmatched ["Taggart Dickson"]`
      // and nobody saw it, because the only trace was a count inside the
      // detail JSON. `status` cannot express "worked, but lost rows" —
      // ingest_runs_status_chk permits only running/success/empty/error, and
      // 'error' would be a lie for a run that upserted 98 good rows.
      // So error_text carries it: it is the field the run-outcome surfaces
      // actually show, and a non-null error_text on a successful run reads as
      // exactly what it is — attention needed, not failure.
      const lossNotes: string[] = [];
      if (stats.failures.length > 0) {
        lossNotes.push(`${stats.failures.length} recompute failure(s); see detail`);
      }
      if (stats.unmatched_rows > 0) {
        // Name them. The COUNT alone is what made this invisible for two
        // nights — 22 of one night's 24 were newly-minted hires that
        // self-heal once CP stamps them, and 2 were a permanent identity
        // mismatch. Only the names tell those apart.
        lossNotes.push(
          `${stats.unmatched_rows} row(s) skipped unmatched: ${stats.unmatched
            .slice(0, 10)
            .join(", ")}${stats.unmatched.length > 10 ? ", …" : ""}`
        );
      }
      if (stats.inactive_rows > 0) {
        lossNotes.push(`${stats.inactive_rows} row(s) skipped inactive`);
      }
      if (lossNotes.length > 0) outcome.error_text = lossNotes.join(" | ");
    } catch (err) {
      outcome.status = "error";
      outcome.error_text = err instanceof Error ? err.message : String(err);
    }

    await finishRun(supabase, runId, outcome);
    outcomes.push(outcome);
  }

  const streakReasons = await emptyStreakReasons(supabase, outcomes);
  const alert = await maybeSendFailureAlert(outcomes, streakReasons);

  const byStatus: Record<string, number> = {};
  for (const o of outcomes) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

  return {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    locations: locations.length,
    runs: outcomes.length,
    by_status: byStatus,
    alert,
    outcomes: outcomes.map((o) => ({
      location_code: o.location_code,
      status: o.status,
      rows_in: o.rows_in,
      rows_upserted: o.rows_upserted,
      rows_skipped: o.rows_skipped,
      error_text: o.error_text,
    })),
  };
}
