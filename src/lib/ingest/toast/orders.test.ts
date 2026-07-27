/**
 * Unit tests for the Toast orders normalization + business-date windowing.
 *
 * Runs on Node's built-in test runner with native TypeScript type-stripping
 * (npm test). Both functions under test are pure; fixtures mirror the live
 * ordersBulk payload shape verified against COS on 2026-07-26 (dollars on the
 * wire, check.amount = pre-tax net, payment.tipAmount, check.guid stable).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  businessDatesForWindow,
  normalizeOrders,
  type ToastOrder,
} from "./normalize.ts";

const TZ = "America/Denver";
const LOC = "loc-uuid-cos";

function order(overrides: Partial<ToastOrder> = {}): ToastOrder {
  return {
    guid: "order-1",
    businessDate: 20260725,
    source: "In Store",
    voided: false,
    deleted: false,
    createdInTestMode: false,
    server: { guid: "server-1" },
    paidDate: "2026-07-25T19:30:00.000+0000",
    checks: [
      {
        guid: "check-1",
        displayNumber: "16779",
        amount: 27.9,
        totalAmount: 35.18,
        taxAmount: 2.28,
        voided: false,
        deleted: false,
        paidDate: "2026-07-25T19:30:00.000+0000",
        payments: [
          { amount: 30.18, tipAmount: 5, type: "OTHER", refundStatus: "NONE" },
        ],
      },
    ],
    ...overrides,
  };
}

test("normalize maps a check to the sales_records payload shape", () => {
  const r = normalizeOrders([order()], LOC, TZ);
  assert.equal(r.payloads.length, 1);
  const p = r.payloads[0];
  assert.equal(p.location_id, LOC);
  assert.equal(p.receipt_number, "check-1"); // check.guid, not displayNumber
  // 19:30 UTC -> 13:30 Denver (MDT), local wall-clock with no TZ suffix
  assert.equal(p.transaction_at, "2026-07-25T13:30:00");
  assert.equal(p.transaction_type, "Sales");
  assert.equal(p.total_amount, 27.9); // net (pre-tax) base, dollars
  assert.equal(p.tip_amount, 5);
  assert.equal(p.payment_type, "OTHER");
  assert.equal(p.channel, "In Store");
  assert.equal(p.raw_row.server_guid, "server-1");
  assert.equal(p.raw_row.total_amount_with_tax, 35.18);
});

test("test-mode, voided, and deleted orders/checks are skipped", () => {
  const r = normalizeOrders(
    [
      order({ createdInTestMode: true }),
      order({ voided: true }),
      order({
        checks: [
          { guid: "c-void", amount: 10, voided: true, payments: [] },
          {
            guid: "c-ok",
            amount: 12.5,
            paidDate: "2026-07-25T20:00:00.000+0000",
            payments: [],
          },
        ],
      }),
    ],
    LOC,
    TZ
  );
  assert.equal(r.payloads.length, 1);
  assert.equal(r.payloads[0].receipt_number, "c-ok");
  assert.equal(r.skipped_test_mode, 1);
  assert.equal(r.skipped_voided, 2); // whole voided order + the voided check
});

test("tips sum across split tender and net out tip refunds", () => {
  const o = order({
    checks: [
      {
        guid: "c-split",
        amount: 40,
        paidDate: "2026-07-25T20:00:00.000+0000",
        payments: [
          { tipAmount: 3, type: "CREDIT", refundStatus: "NONE" },
          {
            tipAmount: 2,
            type: "CASH",
            refundStatus: "FULL",
            refund: { refundAmount: 20, tipRefundAmount: 2 },
          },
        ],
      },
    ],
  });
  const r = normalizeOrders([o], LOC, TZ);
  assert.equal(r.payloads[0].tip_amount, 3); // 3 + (2 - 2)
  assert.equal(r.payloads[0].payment_type, "CREDIT+CASH");
  assert.deepEqual(r.payloads[0].raw_row.refund_statuses, ["FULL"]);
});

test("a check with no usable timestamp is counted, not landed", () => {
  const o = order({ paidDate: null, closedDate: null, openedDate: null });
  o.checks![0].paidDate = null;
  o.checks![0].closedDate = null;
  const r = normalizeOrders([o], LOC, TZ);
  assert.equal(r.payloads.length, 0);
  assert.equal(r.skipped_no_date, 1);
});

test("negative net lands as a Refund row", () => {
  const o = order({
    checks: [
      {
        guid: "c-neg",
        amount: -8.5,
        paidDate: "2026-07-25T20:00:00.000+0000",
        payments: [],
      },
    ],
  });
  const r = normalizeOrders([o], LOC, TZ);
  assert.equal(r.payloads[0].transaction_type, "Refund");
  assert.equal(r.payloads[0].total_amount, -8.5);
});

test("window enumerates local business dates with 1-day overlap", () => {
  // Window start 2026-07-20T09:00Z = 7/20 03:00 Denver; overlap steps to 7/19.
  const { dates, truncated } = businessDatesForWindow(
    "2026-07-20T09:00:00.000Z",
    "2026-07-23T09:00:00.000Z",
    TZ,
    "2026-07-07"
  );
  assert.deepEqual(dates, ["20260719", "20260720", "20260721", "20260722", "20260723"]);
  assert.equal(truncated, 0);
});

test("window start is clamped to the store's Toast go-live floor", () => {
  // Asking for Cake-owned dates (pre 7/7) must not produce them.
  const { dates } = businessDatesForWindow(
    "2026-07-01T00:00:00.000Z",
    "2026-07-09T09:00:00.000Z",
    TZ,
    "2026-07-07"
  );
  assert.equal(dates[0], "20260707");
  assert.equal(dates[dates.length - 1], "20260709");
});

test("oversized windows keep the OLDEST dates and report truncation", () => {
  const { dates, truncated } = businessDatesForWindow(
    "2026-01-01T00:00:00.000Z",
    "2026-07-25T09:00:00.000Z",
    TZ,
    "2026-01-01",
    10
  );
  assert.equal(dates.length, 10);
  // 1/1T00:00Z is 12/31 local; minus overlap = 12/30; floor clamps to 1/1.
  assert.equal(dates[0], "20260101");
  assert.equal(dates[9], "20260110");
  assert.ok(truncated > 0);
});

test("floor also applies to the overlap day", () => {
  const { dates } = businessDatesForWindow(
    "2026-07-07T00:00:00.000Z",
    "2026-07-08T09:00:00.000Z",
    TZ,
    "2026-07-07"
  );
  // 7/7T00:00Z is 7/6 local; minus overlap = 7/5; floor clamps to 7/7.
  assert.equal(dates[0], "20260707");
});
