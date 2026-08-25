/**
 * Toast sales ingest orchestrator: fan the direct Toast Orders pull out over
 * the stores wired for it (handoff-co-sales-toast-plus-cake-2026-07-26.md §2).
 *
 * The crosswalk is the explicit `locations.toast_sales_enabled` flag
 * (migration 041) — the 6 CO stores and ONLY them. The provisioned credential
 * can see 9 restaurants (CO + Houston + Chico + a stray second Fort Collins),
 * but Houston's sales already arrive via the 7shifts pos_receipts nightly (a
 * Toast pull would double-source them) and the others are not EPD stores.
 * Before 041 the guard was implicitly "toast_restaurant_guid IS NOT NULL";
 * the kitchen feed needs HOU's GUID populated, so the flag now carries the
 * enforcement and the GUID column is pure identity. Never iterate "all
 * locations the credential can see", and never set toast_sales_enabled for
 * HOU.
 *
 * Each store gets its own incremental window: lastSuccessfulWindowEnd ->
 * now, with the very first run (or an operator `since` override) floored at
 * the store's toast_sales_start_date — the day after its Cake backfill ends,
 * so the Cake<->Toast seam has no gap and no overlap. One ingest_runs row per
 * store per run (source 'toast_sales'); outcomes feed the same failure alert
 * and empty-streak guard as the nightly 7shifts ingest.
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
import type { AdminClient } from "../sevenshifts/crosswalk";
import { ingestToastSales } from "./orders";

/** One location's Toast wiring, read from the migration-038 columns. */
export interface ToastLocation {
  id: string;
  name: string;
  location_code: string;
  toast_restaurant_guid: string;
  /** YYYY-MM-DD Toast go-live; the hard floor for every pull window. */
  toast_sales_start_date: string;
}

export async function loadToastCrosswalk(
  supabase: AdminClient
): Promise<ToastLocation[]> {
  const { data, error } = await supabase
    .from("locations")
    .select("id, name, location_code, toast_restaurant_guid, toast_sales_start_date")
    .eq("toast_sales_enabled", true)
    // A sales-enabled store must still carry its GUID; the flag is the
    // authorization, the GUID the address.
    .not("toast_restaurant_guid", "is", null)
    .order("location_code");
  if (error) {
    throw new Error(`Failed to load Toast crosswalk: ${error.message}`);
  }
  return (data ?? []).map((r) => {
    const goLive = (r.toast_sales_start_date as string | null) ?? null;
    // Same rule as the labor/kitchen loaders (§1, addendum 2026-08-25): the
    // store's own go-live is the only floor. A constant fallback here is the
    // exact defect that hid Houston's pre-July punches — a sales-enabled
    // store without a go-live is a config error that fails loudly.
    if (!goLive) {
      throw new Error(
        `Toast sales: ${String(r.location_code)} is sales-enabled but has no toast_sales_start_date — set the store's go-live before ingesting`
      );
    }
    return {
      id: r.id as string,
      name: r.name as string,
      location_code: r.location_code as string,
      toast_restaurant_guid: r.toast_restaurant_guid as string,
      toast_sales_start_date: goLive,
    };
  });
}

export interface ToastIngestSummary {
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

export interface ToastIngestOptions {
  /** Restrict to one store (location_code); default all wired stores. */
  locationCode?: string;
  /** Override the window start (YYYY-MM-DD) — operator catch-up. Still
   * clamped to each store's toast_sales_start_date floor by the fetcher. */
  since?: string;
}

export async function runToastSalesIngest(
  options: ToastIngestOptions = {}
): Promise<ToastIngestSummary> {
  const startedAt = new Date().toISOString();
  const windowEnd = startedAt;
  const supabase = createAdminClient();

  let crosswalk = await loadToastCrosswalk(supabase);
  if (options.locationCode) {
    crosswalk = crosswalk.filter((l) => l.location_code === options.locationCode);
    if (crosswalk.length === 0) {
      throw new Error(
        `No Toast-wired location with code "${options.locationCode}" (wired: 6 CO stores).`
      );
    }
  }

  const outcomes: RunOutcome[] = [];
  for (const loc of crosswalk) {
    let start: string;
    if (options.since) {
      start = `${options.since}T00:00:00.000Z`;
    } else {
      const last = await lastSuccessfulWindowEnd(supabase, "toast_sales", loc.id);
      start = last ?? `${loc.toast_sales_start_date}T00:00:00.000Z`;
    }

    const runId = await startRun(supabase, "toast_sales", loc.id, start, windowEnd);
    const outcome = await ingestToastSales(supabase, loc, start, windowEnd);
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
    locations: crosswalk.length,
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
