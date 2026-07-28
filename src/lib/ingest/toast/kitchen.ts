/**
 * Toast Kitchen API fetcher: one businessDate, one restaurant (handoff
 * 2026-07-28 §5.2). Sits on the shared client.ts as a sibling to orders.ts —
 * same auth/token/host layer, no second auth path.
 *
 * The export is NOT paginated (spec: businessDate is the only parameter) and
 * the Step-0 probe measured ~300-600 rows/store/day, so one GET per
 * (store, date) is the whole fetch. A 204 response is Toast's "no RMS Pro+
 * subscription" signal — the probe confirmed 200s on this credential
 * (2026-07-28), but the tier could lapse, so the caller must treat a 204 as a
 * loud error, never as an empty day.
 */

import { toastGetWithStatus } from "./client";

export const KITCHEN_EXPORT_PATH = "/kitchen/v1/export/itemFulfillments";

export interface ItemFulfillment {
  restaurantGuid?: string;
  orderGuid?: string;
  ticketGuid?: string;
  selectionGuid?: string;
  selectionMenuItemGuid?: string | null;
  selectionMenuItemName?: string | null;
  selectionMenuItemMultiLocationId?: string | null;
  ticketFiredAt?: string | null;
  itemStartedAt?: string | null;
  itemFulfilledAt?: string | null;
  itemFulfillmentLevel?: number | null;
  prepStationGuid?: string | null;
  prepStationName?: string | null;
  prepStationMultiLocationId?: string | null;
  diningOptionGuid?: string | null;
  diningOptionName?: string | null;
  diningOptionBehavior?: string | null;
  courseGuid?: string | null;
  courseName?: string | null;
  orderSource?: string | null;
}

export interface KitchenDayResult {
  /** Terminal HTTP status — 200 (rows), 204 (RMS Pro+ gate), or an error code. */
  status: number;
  rows: ItemFulfillment[];
  error_body?: string;
}

/** Fetch one store's item fulfillments for one businessDate (YYYYMMDD). */
export async function fetchItemFulfillments(
  restaurantGuid: string,
  businessDate: string
): Promise<KitchenDayResult> {
  const res = await toastGetWithStatus<ItemFulfillment[]>(
    restaurantGuid,
    KITCHEN_EXPORT_PATH,
    { businessDate }
  );
  return {
    status: res.status,
    rows: Array.isArray(res.body) ? res.body : [],
    error_body: res.error_body,
  };
}
