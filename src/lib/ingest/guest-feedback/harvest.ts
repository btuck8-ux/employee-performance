/**
 * Unified guest-feedback harvester (handoff §1/§4).
 *
 * One server-side run pulls the three unautomated sources — Tattle snapshots,
 * Tattle online reviews, and per-employee 7Tasks — normalizes each captured
 * vendor response into the importer's parsed shape (reusing parse*Csv), and
 * lands rows through the SAME exported ingest*ForLocation compute the manual
 * uploads use. A `since` floor makes one run double as the backfill mechanism:
 *   - backfill: ?location=all&since=2026-04-01 re-pulls the quarter for every store
 *   - nightly:  rolling per-(source,location) incremental window, no `since`
 *
 * Fetch is SHARED to avoid hammering the vendors: Tattle snapshots/reviews are
 * pulled once for merchant 2685; the Tasks export runs once per 7shifts company
 * (the CSV `Location` column routes its stores). Ingest + the ingest_runs row are
 * PER (source × location), each with its own incremental window via runs.ts, so
 * the high-water mark advances per location exactly like the 7shifts orchestrator.
 * Outcomes feed maybeSendFailureAlert + emptyStreakReasons (handoff §4b).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { AdminClient } from "@/lib/ingest/sevenshifts/crosswalk";
import {
  startRun,
  finishRun,
  lastSuccessfulWindowEnd,
  type IngestSource,
  type IngestStatus,
  type RunOutcome,
} from "@/lib/ingest/sevenshifts/runs";
import { maybeSendFailureAlert } from "@/lib/ingest/sevenshifts/alert";
import { emptyStreakReasons } from "@/lib/ingest/sevenshifts/streak";
import { ingestTattlesForLocation } from "@/lib/ingest/tattle/ingest-location";
import { ingestReviewsForLocation } from "@/lib/ingest/reviews/ingest-location";
import { ingestTasksForLocation } from "@/lib/ingest/tasks/ingest-location";
import { fetchTattleSnapshots } from "./tattle-source";
import { fetchReviews } from "./reviews-source";
import { fetchTasksReport } from "./tasks-source";

export type GuestFeedbackSource = "tattle" | "reviews" | "tasks";
export const ALL_SOURCES: GuestFeedbackSource[] = ["tattle", "reviews", "tasks"];

/** Default rolling lookback (days) when there is no prior run and no `since`. */
const DEFAULT_LOOKBACK_DAYS = 14;

/**
 * 7shifts companies that run the Tasks module: Houston (62064) + the 6 Colorado
 * stores (185592). NOLA (360494) has no 7Tasks (handoff §2), so its locations get
 * no `7tasks` run.
 */
const TASKS_COMPANY_IDS = new Set([62064, 185592]);

/**
 * Locations with no Tattle/Reviews merchant feed — excluded from all guest-
 * feedback sources so they don't drift `empty` nightly and trip the streak alert.
 * NOLA's CS/TIS stay NULL by design (handoff §6.4/§8.4).
 */
const EXCLUDED_CODES = new Set(["NOLA"]);

interface Target {
  id: string;
  name: string;
  location_code: string;
  csv_aliases: string[] | null;
  company_id: number | null;
}

export interface HarvestSummary {
  started_at: string;
  finished_at: string;
  window: { since: string | null; end: string };
  sources: GuestFeedbackSource[];
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

export interface HarvestOptions {
  /** Location codes to target, or "all" for every non-excluded store. */
  locationCodes: string[] | "all";
  /** Backfill floor YYYY-MM-DD; omit for rolling incremental windows. */
  since?: string | null;
  /** Which sources to run; defaults to all three. */
  sources?: GuestFeedbackSource[];
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function lookbackDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Load target locations (with aliases + 7shifts company) for matching/routing. */
async function loadTargets(
  supabase: AdminClient,
  locationCodes: string[] | "all"
): Promise<Target[]> {
  const { data, error } = await supabase
    .from("locations")
    .select("id, name, location_code, csv_aliases, seven_shifts_company_id")
    .order("location_code");
  if (error) throw new Error(`Failed to load locations: ${error.message}`);

  let rows = (data ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    location_code: r.location_code as string,
    csv_aliases: (r.csv_aliases as string[] | null) ?? null,
    company_id:
      r.seven_shifts_company_id != null ? Number(r.seven_shifts_company_id) : null,
  }));

  rows = rows.filter((r) => !EXCLUDED_CODES.has(r.location_code));
  if (locationCodes !== "all") {
    const want = new Set(locationCodes.map((c) => c.toLowerCase()));
    rows = rows.filter((r) => want.has(r.location_code.toLowerCase()));
  }
  return rows;
}

/**
 * Per-(source, location) incremental window. `since` (backfill) overrides; else
 * resume from the last successful run's window_end; else a rolling default.
 * Returns the date for the vendor query plus the ISO window_start for the run row.
 */
async function windowFor(
  supabase: AdminClient,
  source: IngestSource,
  locId: string,
  since: string | null
): Promise<{ startDate: string; windowStartIso: string }> {
  if (since) return { startDate: since, windowStartIso: `${since}T00:00:00.000Z` };
  const last = await lastSuccessfulWindowEnd(supabase, source, locId);
  if (last) return { startDate: last.slice(0, 10), windowStartIso: last };
  const def = lookbackDate(DEFAULT_LOOKBACK_DAYS);
  return { startDate: def, windowStartIso: `${def}T00:00:00.000Z` };
}

/** Min YYYY-MM-DD across a list (for the shared fetch window). */
function minDate(dates: string[]): string {
  return dates.reduce((a, b) => (a < b ? a : b));
}

function statusFromCounts(touched: number, failures: string[]): IngestStatus {
  if (failures.length > 0) return "error";
  return touched > 0 ? "success" : "empty";
}

/**
 * Record an `error` run for every target of a source whose SHARED fetch failed
 * (e.g. a session expired). One run per location so the failure is visible per
 * store and the alert/streak guards engage.
 */
async function recordFetchError(
  supabase: AdminClient,
  source: IngestSource,
  targets: Target[],
  windows: Map<string, { startDate: string; windowStartIso: string }>,
  endIso: string,
  message: string
): Promise<RunOutcome[]> {
  const out: RunOutcome[] = [];
  for (const loc of targets) {
    const w = windows.get(loc.id)!;
    const runId = await startRun(supabase, source, loc.id, w.windowStartIso, endIso);
    const outcome: RunOutcome = {
      source,
      location_id: loc.id,
      location_code: loc.location_code,
      status: "error",
      rows_in: 0,
      rows_upserted: 0,
      rows_skipped: 0,
      detail: null,
      error_text: message,
      window_start: w.windowStartIso,
      window_end: endIso,
    };
    await finishRun(supabase, runId, {
      status: "error",
      rows_in: 0,
      rows_upserted: 0,
      rows_skipped: 0,
      error_text: message,
    });
    out.push(outcome);
  }
  return out;
}

export async function runGuestFeedbackHarvest(
  opts: HarvestOptions
): Promise<HarvestSummary> {
  const startedAt = new Date().toISOString();
  const endIso = startedAt;
  const endDate = todayDate();
  const sources = opts.sources ?? ALL_SOURCES;
  const since = opts.since ?? null;
  const supabase = createAdminClient();

  const targets = await loadTargets(supabase, opts.locationCodes);
  const outcomes: RunOutcome[] = [];

  // ---- Source A: Tattle snapshots ----
  if (sources.includes("tattle") && targets.length > 0) {
    const windows = new Map<string, { startDate: string; windowStartIso: string }>();
    for (const loc of targets) {
      windows.set(loc.id, await windowFor(supabase, "tattle", loc.id, since));
    }
    const fetchStart = minDate([...windows.values()].map((w) => w.startDate));
    try {
      const parsed = await fetchTattleSnapshots(fetchStart, endDate);
      for (const loc of targets) {
        const w = windows.get(loc.id)!;
        const runId = await startRun(supabase, "tattle", loc.id, w.windowStartIso, endIso);
        const stats = await ingestTattlesForLocation(supabase, parsed, loc);
        const touched = stats.surveys_inserted + stats.surveys_updated;
        const status = statusFromCounts(touched, stats.failures);
        await finishRun(supabase, runId, {
          status,
          rows_in: touched,
          rows_upserted: touched,
          rows_skipped: stats.skipped_other_location,
          detail: { ...stats },
          error_text: stats.failures.length > 0 ? stats.failures.slice(0, 3).join(" | ") : null,
        });
        outcomes.push({
          source: "tattle",
          location_id: loc.id,
          location_code: loc.location_code,
          status,
          rows_in: touched,
          rows_upserted: touched,
          rows_skipped: stats.skipped_other_location,
          detail: null,
          error_text: stats.failures[0] ?? null,
          window_start: w.windowStartIso,
          window_end: endIso,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[harvest] tattle fetch failed:", message);
      outcomes.push(
        ...(await recordFetchError(supabase, "tattle", targets, windows, endIso, message))
      );
    }
  }

  // ---- Source B: Online Reviews ----
  if (sources.includes("reviews") && targets.length > 0) {
    const windows = new Map<string, { startDate: string; windowStartIso: string }>();
    for (const loc of targets) {
      windows.set(loc.id, await windowFor(supabase, "reviews", loc.id, since));
    }
    const fetchStart = minDate([...windows.values()].map((w) => w.startDate));
    try {
      const parsed = await fetchReviews(fetchStart, endDate);
      for (const loc of targets) {
        const w = windows.get(loc.id)!;
        const runId = await startRun(supabase, "reviews", loc.id, w.windowStartIso, endIso);
        const stats = await ingestReviewsForLocation(supabase, parsed, loc);
        const touched = stats.reviews_inserted + stats.reviews_updated;
        const status = statusFromCounts(touched, stats.failures);
        await finishRun(supabase, runId, {
          status,
          rows_in: touched,
          rows_upserted: touched,
          rows_skipped: stats.skipped_other_location,
          detail: { ...stats },
          error_text: stats.failures.length > 0 ? stats.failures.slice(0, 3).join(" | ") : null,
        });
        outcomes.push({
          source: "reviews",
          location_id: loc.id,
          location_code: loc.location_code,
          status,
          rows_in: touched,
          rows_upserted: touched,
          rows_skipped: stats.skipped_other_location,
          detail: null,
          error_text: stats.failures[0] ?? null,
          window_start: w.windowStartIso,
          window_end: endIso,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[harvest] reviews fetch failed:", message);
      outcomes.push(
        ...(await recordFetchError(supabase, "reviews", targets, windows, endIso, message))
      );
    }
  }

  // ---- Source C: per-employee 7Tasks (one export per company, routed by store) ----
  if (sources.includes("tasks")) {
    const taskTargets = targets.filter(
      (t) => t.company_id != null && TASKS_COMPANY_IDS.has(t.company_id)
    );
    const byCompany = new Map<number, Target[]>();
    for (const t of taskTargets) {
      const list = byCompany.get(t.company_id!);
      if (list) list.push(t);
      else byCompany.set(t.company_id!, [t]);
    }

    for (const [companyId, companyTargets] of byCompany) {
      const windows = new Map<string, { startDate: string; windowStartIso: string }>();
      for (const loc of companyTargets) {
        windows.set(loc.id, await windowFor(supabase, "7tasks", loc.id, since));
      }
      const fetchStart = minDate([...windows.values()].map((w) => w.startDate));
      try {
        const parsed = await fetchTasksReport(companyId, fetchStart, endDate);
        for (const loc of companyTargets) {
          const w = windows.get(loc.id)!;
          const runId = await startRun(supabase, "7tasks", loc.id, w.windowStartIso, endIso);
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
            error_text: stats.failures.length > 0 ? stats.failures.slice(0, 3).join(" | ") : null,
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
            window_start: w.windowStartIso,
            window_end: endIso,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[harvest] tasks fetch failed (company ${companyId}):`, message);
        outcomes.push(
          ...(await recordFetchError(supabase, "7tasks", companyTargets, windows, endIso, message))
        );
      }
    }
  }

  // ---- Alerting: error runs + per-(source,location) empty-streak (handoff §4b) ----
  const streakReasons = await emptyStreakReasons(supabase, outcomes);
  const alert = await maybeSendFailureAlert(outcomes, streakReasons);

  const byStatus: Record<string, number> = {};
  for (const o of outcomes) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

  return {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    window: { since, end: endDate },
    sources,
    locations: targets.length,
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
