/**
 * 7shifts receipts -> EPD `sales_records`.
 *
 * Only runs for locations with `pos_via_7shifts = true` (the POS integration is
 * live in 7shifts). receipt_date is UTC; we project it to the store's local
 * wall-clock so transaction_at lines up with worked time_entries for the
 * presence-based tip attribution (migration 016).
 *
 * Money is cents on the wire -> dollars in sales_records. total_amount uses
 * net_total (pre-tax, post-discount, pre-tip) as the sales base; tip_amount
 * uses the top-level `tips`. tip_details + external_user_id are preserved in
 * raw_row for audit. Refunds carry signed (negative) values and net naturally.
 *
 * 90-day lookback is a hard API cap: receipt_date[gte] more than 90 days back
 * returns 400, so the window start is clamped to 89 days.
 */

import { getAll } from "./client";
import { utcToLocalWallClock, timezoneForLocationCode } from "./tz";
import { recomputeAfterSalesUpsert } from "./recompute";
import type { AdminClient, LocationCrosswalk } from "./crosswalk";
import type { RunOutcome } from "./runs";

interface TipDetail {
  type?: string;
  value?: number; // cents
}

interface Receipt {
  id?: string;
  receipt_id: string;
  location_id: number;
  receipt_date: string; // UTC ISO8601
  net_total: number; // cents
  gross_total?: number | null; // cents
  tips?: number | null; // cents
  external_user_id?: string | null;
  revenue_center?: string | null;
  status?: string;
  tip_details?: TipDetail[] | null;
}

const RECEIPTS_LOOKBACK_CAP_DAYS = 89;

/** Clamp window start to within the 90-day API cap (returns UTC ISO). */
function clampReceiptWindowStart(windowStart: string): string {
  const start = new Date(windowStart).getTime();
  const floor = Date.now() - RECEIPTS_LOOKBACK_CAP_DAYS * 24 * 60 * 60 * 1000;
  return new Date(Math.max(start, floor)).toISOString();
}

export async function ingestReceipts(
  supabase: AdminClient,
  loc: LocationCrosswalk,
  windowStart: string,
  windowEnd: string
): Promise<RunOutcome> {
  const clampedStart = clampReceiptWindowStart(windowStart);
  const base: RunOutcome = {
    source: "pos_receipts",
    location_id: loc.id,
    location_code: loc.location_code,
    status: "running",
    rows_in: 0,
    rows_upserted: 0,
    rows_skipped: 0,
    detail: null,
    error_text: null,
    window_start: clampedStart,
    window_end: windowEnd,
  };

  try {
    const tz = timezoneForLocationCode(loc.location_code);

    const receipts = await getAll<Receipt>(loc.company_id, "receipts", {
      location_id: loc.seven_shifts_location_id,
      "receipt_date[gte]": clampedStart,
      "receipt_date[lte]": windowEnd,
      status: "closed",
      limit: 100,
    });
    base.rows_in = receipts.length;

    let skippedNoDate = 0;
    const payloads = [];
    for (const r of receipts) {
      const local = utcToLocalWallClock(r.receipt_date, tz);
      if (!local || !r.receipt_id) {
        skippedNoDate += 1;
        continue;
      }
      const total = (r.net_total ?? 0) / 100;
      const tip = (r.tips ?? 0) / 100;
      payloads.push({
        location_id: loc.id,
        receipt_number: r.receipt_id,
        transaction_at: local.timestamp,
        transaction_type: total < 0 ? "Refund" : "Sales",
        order_type: null as string | null,
        channel: null as string | null,
        payment_type: null as string | null,
        register: r.revenue_center ?? null,
        pos_employee_name: null as string | null,
        total_amount: total,
        tip_amount: tip,
        raw_row: {
          external_user_id: r.external_user_id ?? null,
          gross_total_cents: r.gross_total ?? null,
          net_total_cents: r.net_total ?? null,
          tips_cents: r.tips ?? null,
          tip_details: r.tip_details ?? null,
          receipt_date_utc: r.receipt_date,
        },
      });
    }

    let upserted = 0;
    const UPSERT_BATCH = 500;
    for (let i = 0; i < payloads.length; i += UPSERT_BATCH) {
      const batch = payloads.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase
        .from("sales_records")
        .upsert(batch, {
          onConflict: "location_id,receipt_number,transaction_at",
        });
      if (error) throw new Error(`sales_records upsert: ${error.message}`);
      upserted += batch.length;
    }

    // POS attribution is presence-based, so every active employee at the
    // location for an affected quarter must be recomputed, then the team
    // tip-impact slice rebuilt per quarter — the shared post-sales tail.
    const rc = await recomputeAfterSalesUpsert(
      supabase,
      loc.id,
      payloads.map((p) => p.transaction_at)
    );

    if (payloads.length > 0) {
      await supabase
        .from("locations")
        .update({ last_data_uploaded_at: new Date().toISOString() })
        .eq("id", loc.id);
    }

    base.rows_upserted = upserted;
    base.rows_skipped = skippedNoDate;
    base.detail = {
      receipts_fetched: receipts.length,
      sales_upserted: upserted,
      quarters_recomputed: rc.quarters.length,
      records_recomputed: rc.recomputed,
      teams_recomputed: rc.teams_recomputed,
      skipped_no_date: skippedNoDate,
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
