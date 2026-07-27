/**
 * Toast Orders API -> EPD `sales_records` (the 6 CO stores' permanent feed).
 *
 * Pulls GET /orders/v2/ordersBulk one business date at a time and lands one
 * row per CHECK — the same row-per-receipt grain as the Cake backfill and
 * Houston's 7shifts pos_receipts path — so the downstream tip/CS/TIS pipeline
 * is unchanged. Field mapping + windowing live in normalize.ts (pure,
 * unit-tested); this file owns the fetch, the upsert, and the shared
 * post-sales recompute tail.
 *
 * Seam guards (Cake ended the day before each store's go-live):
 *  - every pull window is clamped to locations.toast_sales_start_date, so
 *    Toast never writes a business date the Cake backfill owns;
 *  - createdInTestMode orders are skipped (pre-go-live days hold only these).
 */

import { getPagedList } from "./client";
import {
  businessDatesForWindow,
  normalizeOrders,
  type ToastOrder,
} from "./normalize";
import { timezoneForLocationCode } from "../sevenshifts/tz";
import { recomputeAfterSalesUpsert } from "../sevenshifts/recompute";
import type { AdminClient } from "../sevenshifts/crosswalk";
import type { RunOutcome } from "../sevenshifts/runs";
import type { ToastLocation } from "./orchestrator";

/**
 * One store's Toast sales pull for one window: fetch every business date,
 * upsert on the (location_id, receipt_number, transaction_at) natural key,
 * then run the shared post-sales recompute tail. Mirrors ingestReceipts()
 * shape so orchestrator/runs/alert plumbing is interchangeable.
 */
export async function ingestToastSales(
  supabase: AdminClient,
  loc: ToastLocation,
  windowStart: string,
  windowEnd: string
): Promise<RunOutcome> {
  const base: RunOutcome = {
    source: "toast_sales",
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
    const tz = timezoneForLocationCode(loc.location_code);
    const { dates, truncated } = businessDatesForWindow(
      windowStart,
      windowEnd,
      tz,
      loc.toast_sales_start_date
    );

    // If the window held more dates than one run may pull, clamp the recorded
    // high-water mark to the last date actually pulled — lastSuccessfulWindowEnd
    // drives the next window, so the un-pulled tail is picked up next run
    // instead of silently skipped (finishRun persists this window_end).
    if (truncated > 0 && dates.length > 0) {
      const last = dates[dates.length - 1];
      base.window_end = `${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6, 8)}T23:59:59.000Z`;
    }

    const orders: ToastOrder[] = [];
    for (const businessDate of dates) {
      const batch = await getPagedList<ToastOrder>(
        loc.toast_restaurant_guid,
        "/orders/v2/ordersBulk",
        { businessDate }
      );
      orders.push(...batch);
    }
    base.rows_in = orders.length;

    const normalized = normalizeOrders(orders, loc.id, tz);

    let upserted = 0;
    const UPSERT_BATCH = 500;
    for (let i = 0; i < normalized.payloads.length; i += UPSERT_BATCH) {
      const batch = normalized.payloads.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase.from("sales_records").upsert(batch, {
        onConflict: "location_id,receipt_number,transaction_at",
      });
      if (error) throw new Error(`sales_records upsert: ${error.message}`);
      upserted += batch.length;
    }

    const rc = await recomputeAfterSalesUpsert(
      supabase,
      loc.id,
      normalized.payloads.map((p) => p.transaction_at)
    );

    if (normalized.payloads.length > 0) {
      await supabase
        .from("locations")
        .update({ last_data_uploaded_at: new Date().toISOString() })
        .eq("id", loc.id);
    }

    base.rows_upserted = upserted;
    base.rows_skipped =
      normalized.skipped_test_mode + normalized.skipped_voided + normalized.skipped_no_date;
    base.detail = {
      business_dates_pulled: dates.length,
      business_dates_truncated: truncated,
      orders_fetched: orders.length,
      checks_upserted: upserted,
      skipped_test_mode: normalized.skipped_test_mode,
      skipped_voided: normalized.skipped_voided,
      skipped_no_date: normalized.skipped_no_date,
      quarters_recomputed: rc.quarters.length,
      records_recomputed: rc.recomputed,
      teams_recomputed: rc.teams_recomputed,
      recompute_failures: rc.failures.slice(0, 20),
    };
    base.status = upserted > 0 ? "success" : "empty";
    if (rc.failures.length > 0) {
      base.error_text = `${rc.failures.length} recompute failure(s); see detail`;
    }
    return base;
  } catch (err) {
    base.status = "error";
    base.error_text = err instanceof Error ? err.message : String(err);
    return base;
  }
}
