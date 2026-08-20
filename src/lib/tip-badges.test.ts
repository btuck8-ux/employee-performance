/**
 * Tip vs-store badge copy + tone bands (§5-E, kickoff 2026-08-19).
 *
 * The dollar phrasing is an EXACT unit conversion (tip rate = tips ÷ sales →
 * pp × 100 = cents per $100 sold), so the wording is pinned literally — the
 * packet's own worked example (−0.35pp → "35¢ … below") is the anchor case.
 * Text-level pins keep both consumers (dashboard table + PDF) on the shared
 * module so the two surfaces can't drift apart again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TIP_DELTA_NEUTRAL_PP,
  TIP_PER_HOUR_NEUTRAL_USD,
  tipPerHourDeltaLabel,
  tipPerHourTone,
  tipRateDeltaLabel,
  tipRateTone,
} from "./tip-badges.ts";

test("tip-rate label: packet's worked example and sign framing", () => {
  assert.equal(tipRateDeltaLabel(-0.35), "35¢ per $100 sold below store average");
  assert.equal(tipRateDeltaLabel(0.35), "35¢ per $100 sold above store average");
});

test("tip-rate label: ≥100¢ switches to dollar form", () => {
  assert.equal(tipRateDeltaLabel(-1.2), "$1.20 per $100 sold below store average");
});

test("tip-rate label: rounds to whole cents; ~zero reads at-average", () => {
  assert.equal(tipRateDeltaLabel(-0.352), "35¢ per $100 sold below store average");
  assert.equal(tipRateDeltaLabel(0), "at store average");
  assert.equal(tipRateDeltaLabel(0.004), "at store average"); // rounds to 0¢
});

test("tip-rate tone: band edges are meets-inclusive (matches the old badge)", () => {
  assert.equal(tipRateTone(TIP_DELTA_NEUTRAL_PP), "meets");
  assert.equal(tipRateTone(-TIP_DELTA_NEUTRAL_PP), "meets");
  assert.equal(tipRateTone(TIP_DELTA_NEUTRAL_PP + 0.01), "exceeds");
  assert.equal(tipRateTone(-TIP_DELTA_NEUTRAL_PP - 0.01), "below");
});

test("tip-per-hour label: dollar framing and ~zero at-average", () => {
  assert.equal(tipPerHourDeltaLabel(-1.51), "$1.51/hr below store average");
  assert.equal(tipPerHourDeltaLabel(0.3), "$0.30/hr above store average");
  assert.equal(tipPerHourDeltaLabel(0.004), "at store average");
});

test("tip-per-hour tone: ±$0.25/hr band, meets-inclusive edges", () => {
  assert.equal(tipPerHourTone(TIP_PER_HOUR_NEUTRAL_USD), "meets");
  assert.equal(tipPerHourTone(-TIP_PER_HOUR_NEUTRAL_USD), "meets");
  assert.equal(tipPerHourTone(0.26), "exceeds");
  assert.equal(tipPerHourTone(-0.26), "below");
});

test("UI table and PDF both source the shared module (drift guard)", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const tabs = read("src/components/employee/PerformanceHistoryTabs.tsx");
  const pdf = read("src/lib/pdf/EmployeeReport.tsx");
  for (const [name, src] of [["PerformanceHistoryTabs", tabs], ["EmployeeReport", pdf]] as const) {
    assert.match(src, /from "@\/lib\/tip-badges"/, `${name} imports the shared module`);
    assert.doesNotMatch(
      src,
      /const TIP_DELTA_NEUTRAL_PP\s*=/,
      `${name} must not redefine the rate band locally`
    );
  }
});
