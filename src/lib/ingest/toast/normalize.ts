/**
 * Pure Toast Orders normalization + business-date windowing.
 *
 * Split from orders.ts so the unit tests load it standalone under Node's
 * type-stripping test runner (the fetch/ingest side pulls in the recompute
 * chain and its @/lib path aliases, which node --test cannot resolve). Keep
 * this file free of runtime imports beyond tz.ts.
 *
 * Payload facts verified against live COS data 7/26:
 *  - Money is DOLLARS on the wire (unlike 7shifts' cents).
 *  - check.amount = pre-tax, post-discount net — the same sales base as
 *    7shifts' net_total. tip = sum of payments' tipAmount (net of any
 *    tipRefund). check.totalAmount (with tax+tip) is kept in raw_row.
 *  - check.guid is the stable receipt id (displayNumber resets daily).
 *  - Timestamps are UTC ISO; projected to store-local wall-clock (tz.ts) so
 *    transaction_at overlaps worked time_entries for tip attribution.
 */

// Explicit .ts extension so Node's type-stripping test runner can resolve it
// when orders.test.ts loads this file standalone (allowImportingTsExtensions).
import { utcToLocalWallClock } from "../sevenshifts/tz.ts";

interface ToastPaymentRefund {
  refundAmount?: number | null; // dollars
  tipRefundAmount?: number | null; // dollars
}

interface ToastPayment {
  guid?: string;
  amount?: number | null; // dollars, excludes tip
  tipAmount?: number | null; // dollars
  type?: string | null; // CASH | CREDIT | OTHER | ...
  refundStatus?: string | null; // NONE | PARTIAL | FULL
  refund?: ToastPaymentRefund | null;
}

interface ToastCheck {
  guid: string;
  displayNumber?: string | number | null;
  amount?: number | null; // dollars: pre-tax, post-discount net
  totalAmount?: number | null; // dollars: with tax + tip
  taxAmount?: number | null;
  voided?: boolean;
  deleted?: boolean;
  openedDate?: string | null;
  paidDate?: string | null;
  closedDate?: string | null;
  payments?: ToastPayment[] | null;
}

interface ToastRef {
  guid?: string | null;
}

export interface ToastOrder {
  guid: string;
  businessDate?: number; // yyyymmdd int
  source?: string | null; // "In Store" | "Online" | ...
  voided?: boolean;
  deleted?: boolean;
  createdInTestMode?: boolean;
  server?: ToastRef | null;
  revenueCenter?: ToastRef | null;
  openedDate?: string | null;
  paidDate?: string | null;
  closedDate?: string | null;
  checks?: ToastCheck[] | null;
}

/** Upper bound on business dates per run — a runaway guard, generous enough
 * for the go-live catch-up (~4 weeks). Anything longer is reported in detail
 * (never silently truncated) and heals on the next run's incremental window. */
export const MAX_BUSINESS_DATES_PER_RUN = 62;

/** Re-pull this many local days behind the high-water mark each run, so late
 * closeouts/refunds on the seam day are picked up (upsert makes it free). */
const OVERLAP_DAYS = 1;

function toYyyymmdd(isoDate: string): string {
  return isoDate.slice(0, 10).replaceAll("-", "");
}

/**
 * Enumerate the store-local business dates ('YYYYMMDD') a window covers:
 * from (windowStart local date - overlap), clamped to the store's
 * toast_sales_start_date floor, through windowEnd's local date.
 */
export function businessDatesForWindow(
  windowStartIso: string,
  windowEndIso: string,
  timeZone: string,
  floorIsoDate: string,
  maxDates: number = MAX_BUSINESS_DATES_PER_RUN
): { dates: string[]; truncated: number } {
  const startLocal = utcToLocalWallClock(windowStartIso, timeZone);
  const endLocal = utcToLocalWallClock(windowEndIso, timeZone);
  if (!startLocal || !endLocal) return { dates: [], truncated: 0 };

  // Walk local calendar dates via UTC-noon anchors (DST-proof).
  const anchor = new Date(`${startLocal.date}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() - OVERLAP_DAYS);

  const floor = floorIsoDate.slice(0, 10);
  const end = endLocal.date;
  const all: string[] = [];
  for (;;) {
    const iso = anchor.toISOString().slice(0, 10);
    if (iso > end) break;
    if (iso >= floor) all.push(toYyyymmdd(iso));
    anchor.setUTCDate(anchor.getUTCDate() + 1);
  }
  const truncated = Math.max(0, all.length - maxDates);
  // Keep the OLDEST dates when truncating: the recorded high-water mark is
  // clamped to the last pulled date (orders.ts), so the tail lands next run.
  return { dates: all.slice(0, maxDates), truncated };
}

export interface NormalizedSales {
  payloads: Array<{
    location_id: string;
    receipt_number: string;
    transaction_at: string;
    transaction_type: string;
    order_type: string | null;
    channel: string | null;
    payment_type: string | null;
    register: string | null;
    pos_employee_name: string | null;
    total_amount: number;
    tip_amount: number;
    raw_row: Record<string, unknown>;
  }>;
  skipped_test_mode: number;
  skipped_voided: number;
  skipped_no_date: number;
}

/** Round to cents — Toast sends dollars; keep float noise out of sums. */
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Flatten orders -> one sales_records payload per real check. Voided/deleted
 * orders and checks are skipped (they never netted revenue); test-mode orders
 * are skipped (pre-go-live onboarding noise — verified the only content of
 * pre-go-live business dates).
 */
export function normalizeOrders(
  orders: ToastOrder[],
  locationId: string,
  timeZone: string
): NormalizedSales {
  const out: NormalizedSales = {
    payloads: [],
    skipped_test_mode: 0,
    skipped_voided: 0,
    skipped_no_date: 0,
  };

  for (const order of orders) {
    if (order.createdInTestMode) {
      out.skipped_test_mode += order.checks?.length ?? 1;
      continue;
    }
    if (order.voided || order.deleted) {
      out.skipped_voided += order.checks?.length ?? 1;
      continue;
    }
    for (const check of order.checks ?? []) {
      if (check.voided || check.deleted) {
        out.skipped_voided += 1;
        continue;
      }
      const utcAt =
        check.paidDate ?? check.closedDate ?? order.paidDate ?? order.closedDate ?? order.openedDate;
      const local = utcToLocalWallClock(utcAt, timeZone);
      if (!local || !check.guid) {
        out.skipped_no_date += 1;
        continue;
      }

      const total = cents(check.amount ?? 0);
      let tip = 0;
      const paymentTypes = new Set<string>();
      for (const p of check.payments ?? []) {
        tip += (p.tipAmount ?? 0) - (p.refund?.tipRefundAmount ?? 0);
        if (p.type) paymentTypes.add(p.type);
      }
      tip = cents(tip);

      out.payloads.push({
        location_id: locationId,
        receipt_number: check.guid,
        transaction_at: local.timestamp,
        transaction_type: total < 0 ? "Refund" : "Sales",
        order_type: null,
        channel: order.source ?? null,
        payment_type: paymentTypes.size > 0 ? Array.from(paymentTypes).join("+") : null,
        register: null,
        pos_employee_name: null,
        total_amount: total,
        tip_amount: tip,
        raw_row: {
          order_guid: order.guid,
          check_display_number: check.displayNumber ?? null,
          business_date: order.businessDate ?? null,
          // Server GUID kept for a future labor.employees crosswalk — pooled
          // tips today, so it is audit-only (handoff §2.5).
          server_guid: order.server?.guid ?? null,
          revenue_center_guid: order.revenueCenter?.guid ?? null,
          total_amount_with_tax: check.totalAmount ?? null,
          tax_amount: check.taxAmount ?? null,
          refund_statuses:
            (check.payments ?? [])
              .map((p) => p.refundStatus)
              .filter((s) => s && s !== "NONE") as string[],
          paid_date_utc: utcAt ?? null,
        },
      });
    }
  }
  return out;
}
