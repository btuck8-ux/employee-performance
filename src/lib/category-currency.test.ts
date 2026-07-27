/**
 * Unit tests for the report staleness classifier (staleCategories).
 * Pure function; runs standalone under Node's type-stripping test runner.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { staleCategories, type CategoryCurrencyEntry } from "./category-currency.ts";

function entry(key: CategoryCurrencyEntry["key"], through: string | null): CategoryCurrencyEntry {
  return { key, label: key, data_through: through };
}

function iso(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

test("completed period: data through ~period_end is fresh, truncated is stale", () => {
  const periodEnd = "2026-06-30";
  const out = staleCategories(
    [entry("labor", "2026-06-30"), entry("sales", "2026-06-28"), entry("tasks", "2026-05-11")],
    periodEnd
  );
  assert.deepEqual(out.map((e) => e.key), ["tasks"]);
});

test("mid-quarter period: reference is today, not the future period_end", () => {
  const periodEnd = iso(60); // quarter ends 2 months out
  const out = staleCategories(
    [entry("labor", iso(-1)), entry("tasks", iso(-30))],
    periodEnd
  );
  // Labor current through yesterday is fine; tasks 30 days behind is stale.
  assert.deepEqual(out.map((e) => e.key), ["tasks"]);
});

test("null data_through (by-design absent category) is never flagged", () => {
  const out = staleCategories([entry("sales", null)], "2026-06-30");
  assert.equal(out.length, 0);
});
