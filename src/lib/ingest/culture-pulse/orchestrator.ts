/**
 * CP→EPD survey sync orchestrator: fan the Culture Pulse survey pull out over
 * all 8 stores (handoff-cp-survey-feed-EXECUTE-2026-07-26.md §5).
 *
 * Window semantics: CP surveys are WEEKLY (one target_monday per week) and
 * completions can trail the send by days, so instead of a strict incremental
 * high-water mark the nightly run re-pulls a rolling window (default 35 days)
 * — idempotent upserts make the overlap free and late completions get their
 * `completed` flag updated. An operator `since` widens the window for
 * backfill. ingest_runs still records the window per store (source
 * 'culture_pulse', migration 039) for observability.
 *
 * Alerting: errors feed maybeSendFailureAlert as usual, but this source is
 * deliberately EXCLUDED from the uniformly-empty check and the nightly
 * empty-streak guard — a weekly-cadence feed is legitimately empty ~6 of 7
 * nights. The silent-death detector here is staleness: a store with no
 * successful (rows>0) pull in STALE_AFTER_DAYS trips an alert reason, since
 * CP sends to every store weekly.
 *
 * A store with sends but zero completions is success/empty, NOT an error —
 * completions are genuinely sparse (66 lifetime org-wide; COS/FCOL/HRANCH
 * have 0 ever). Do not treat sparse completions as a feed defect.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { startRun, finishRun, type RunOutcome } from "../sevenshifts/runs";
import { maybeSendFailureAlert } from "../sevenshifts/alert";
import type { AdminClient } from "../sevenshifts/crosswalk";
import { loadCpSyncLocations } from "./crosswalk";
import { createCpClient } from "./client";
import { fetchCpSurveyWeeks } from "./fetch";
import { ingestCulturePulseSurveysForLocation } from "./ingest-survey-location";

/** Rolling nightly re-pull window (late completions + send-log corrections). */
const DEFAULT_WINDOW_DAYS = 35;

/** No successful pull in this many days = the weekly feed is silently dead. */
export const STALE_AFTER_DAYS = 9;

export interface CpSyncSummary {
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

export interface CpSyncOptions {
  /** Restrict to one store (location_code); default all 8. */
  locationCode?: string;
  /** Override the window start (YYYY-MM-DD) — operator backfill. */
  since?: string;
}

function defaultSince(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - DEFAULT_WINDOW_DAYS);
  return d.toISOString().slice(0, 10);
}

/** Staleness reasons: stores whose last success is older than the threshold. */
async function cpStalenessReasons(
  supabase: AdminClient,
  outcomes: RunOutcome[]
): Promise<string[]> {
  const reasons: string[] = [];
  const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  for (const o of outcomes) {
    if (o.status !== "empty") continue;
    const { data, error } = await supabase
      .from("ingest_runs")
      .select("started_at")
      .eq("source", "culture_pulse")
      .eq("location_id", o.location_id)
      .eq("status", "success")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn(`[cp-sync] staleness lookup failed (${o.location_code}): ${error.message}`);
      continue;
    }
    const last = data?.started_at ? String(data.started_at) : null;
    if (!last || last < cutoff) {
      reasons.push(
        `${o.location_code} culture_pulse stale: no successful pull since ${last ? last.slice(0, 10) : "ever"} (CP sends weekly)`
      );
    }
  }
  return reasons;
}

export async function runCpSurveySync(
  options: CpSyncOptions = {}
): Promise<CpSyncSummary> {
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
  const since = options.since ?? defaultSince();

  const outcomes: RunOutcome[] = [];
  for (const loc of locations) {
    const windowStart = `${since}T00:00:00.000Z`;
    const windowEnd = new Date().toISOString();
    const runId = await startRun(supabase, "culture_pulse", loc.id, windowStart, windowEnd);

    const outcome: RunOutcome = {
      source: "culture_pulse",
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
      const weeks = await fetchCpSurveyWeeks(cp, loc.cp_location_id, since);
      const stats = await ingestCulturePulseSurveysForLocation(
        supabase,
        { id: loc.id, code: loc.location_code, name: loc.name },
        weeks
      );
      outcome.rows_in = weeks.reduce((n, w) => n + w.members.length, 0);
      outcome.rows_upserted = stats.assignments_upserted;
      outcome.rows_skipped = stats.unresolved.length;
      outcome.detail = {
        weeks: stats.weeks,
        surveys_upserted: stats.surveys_upserted,
        assignments_upserted: stats.assignments_upserted,
        completions: stats.completions,
        resolved_by_code: stats.resolved_by_code,
        resolved_by_name: stats.resolved_by_name,
        unresolved: stats.unresolved.slice(0, 20),
        sends_missing_weeks: stats.sends_missing_weeks,
        recomputed: stats.recomputed,
        recompute_failures: stats.failures.slice(0, 20),
      };
      outcome.status = stats.assignments_upserted > 0 ? "success" : "empty";
      if (stats.failures.length > 0) {
        outcome.error_text = `${stats.failures.length} failure(s); see detail`;
      }
    } catch (err) {
      outcome.status = "error";
      outcome.error_text = err instanceof Error ? err.message : String(err);
    }

    await finishRun(supabase, runId, outcome);
    outcomes.push(outcome);
  }

  const staleReasons = await cpStalenessReasons(supabase, outcomes);
  const alert = await maybeSendFailureAlert(outcomes, staleReasons);

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
