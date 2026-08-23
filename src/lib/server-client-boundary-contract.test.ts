/**
 * Pins for the server/client boundary around the time-window helpers.
 *
 * The 2026-08-14 UI sprint shipped server pages (employee profile, location
 * rankings) that CALL resolveQuarterWindow()/resolveAllTimeWindow() during
 * the server render. Those helpers lived in TimeWindowPicker.tsx — a
 * "use client" module — and Next 16 turns every export of a client module
 * into a client reference: rendering one as a Component is fine, but calling
 * one as a plain function throws at request time ("Attempted to call
 * resolveQuarterWindow() from the server"), which took every data-rich
 * employee profile (and the rankings page) down to an error/404 in prod.
 *
 * The fix (2026-08-17) moved the pure helpers + types to
 * src/components/teams/time-window.ts (no "use client"); the picker
 * re-exports them for client consumers. These TEXT-LEVEL pins keep the
 * split from regressing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const timeWindow = read("src/components/teams/time-window.ts");
const picker = read("src/components/teams/TimeWindowPicker.tsx");
const profilePage = read("src/app/dashboard/employees/[id]/page.tsx");
const rankingsPage = read("src/app/dashboard/locations/[id]/rankings/page.tsx");

test("time-window.ts is server-safe (no use-client directive)", () => {
  // Line-anchored: a directive is a standalone statement line; prose mentions
  // of "use client" in comments must not trip this.
  assert.doesNotMatch(timeWindow, /^\s*["']use client["'];?\s*$/m);
  for (const fn of ["resolveQuarterWindow", "resolveAllTimeWindow", "resolveCustomWindow"]) {
    assert.match(timeWindow, new RegExp(`export function ${fn}\\(`), `${fn} exported`);
  }
});

test("TimeWindowPicker stays a client module and re-exports from time-window", () => {
  assert.match(picker, /^"use client";/, "picker keeps use client");
  assert.match(picker, /from "\.\/time-window"/, "picker sources helpers from time-window");
  // The helper implementations must not move back into the client module.
  assert.doesNotMatch(picker, /export function resolveQuarterWindow/);
  assert.doesNotMatch(picker, /export function resolveAllTimeWindow/);
});

test("server pages import window helpers from time-window, never the picker", () => {
  for (const [name, src] of [
    ["employee profile", profilePage],
    ["location rankings", rankingsPage],
  ] as const) {
    assert.match(
      src,
      /from "@\/components\/teams\/time-window"/,
      `${name} imports the server-safe module`
    );
    // Importing anything from the picker would drag the client-module
    // boundary back into the server render of these pages.
    assert.doesNotMatch(
      src,
      /from "@\/components\/teams\/TimeWindowPicker"/,
      `${name} must not import from the use-client picker module`
    );
  }
});

// ── 2026-08-23 sprint boundaries (§8: every new boundary is pinned here) ────

test("multi-location split: pure math is server-safe, fetch is server-only, card is client", () => {
  const metrics = read("src/lib/multi-location-metrics.ts");
  assert.doesNotMatch(
    metrics,
    /^\s*["']use client["'];?\s*$/m,
    "multi-location-metrics.ts must stay directive-free (shared both sides)"
  );
  assert.doesNotMatch(
    metrics,
    /^import /m,
    "multi-location-metrics.ts stays dependency-free so it can cross the boundary"
  );
  const card = read("src/components/employee/MultiLocationCard.tsx");
  assert.match(card, /^"use client";/);
  assert.doesNotMatch(
    card,
    /multi-location-fetch/,
    "the client card must never import the server-only fetch module"
  );
  const fetchMod = read("src/lib/multi-location-fetch.ts");
  assert.doesNotMatch(fetchMod, /^\s*["']use client["'];?\s*$/m);
});

test("new client controls stay rendered-not-called by their server pages", () => {
  for (const [page, component] of [
    ["src/app/dashboard/reports/page.tsx", "PeriodQuarterPicker"],
    ["src/app/dashboard/admin/users/page.tsx", "UserInviteForm"],
  ] as const) {
    const src = read(page);
    assert.match(src, new RegExp(`<${component}`), `${component} rendered as JSX`);
    assert.doesNotMatch(
      src,
      new RegExp(`${component}\\(`),
      `${component} must never be CALLED from the server page`
    );
  }
});
