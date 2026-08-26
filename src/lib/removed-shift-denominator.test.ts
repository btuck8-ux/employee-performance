/**
 * Denominator spec rev 2 (2026-08-26) §2–§4 + §6 — vendor-removed shifts
 * leave the attendance denominator, with the load-bearing exceptions
 * pinned:
 *
 *   §2 THE TRAP: 36 of the 279 residual person-days WERE worked — somebody
 *   whose shift was swapped away punched anyway. A removed-but-punched day
 *   counts ATTENDED, never dropped; implementing this as a subtraction
 *   would create a smaller version of the error it fixes.
 *   §3 THE BOUNDARY: dates before the mirror's per-location coverage stay
 *   uncorrected ("let's not infer"); a location with no mirror rows
 *   corrects nothing; an employee the mirror cannot judge (no 7shifts
 *   user id → liveDates null) corrects nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// The recompute module uses extensionless "./" + "@/" imports; resolve them
// for the node test runner (the range-feed-contract.test.ts idiom).
interface ResolveResult {
  url: string;
  shortCircuit?: boolean;
  format?: string | null;
}
type NextResolve = (specifier: string, context?: unknown) => ResolveResult;
const { registerHooks } = Module as unknown as {
  registerHooks: (hooks: {
    resolve: (
      specifier: string,
      context: unknown,
      nextResolve: NextResolve
    ) => ResolveResult;
  }) => void;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    let spec = specifier;
    if (spec.startsWith("@/")) {
      spec = new URL(`../${spec.slice(2)}`, import.meta.url).href;
    }
    try {
      return nextResolve(spec, context);
    } catch (err) {
      if (!spec.endsWith(".ts") && /^(\.{1,2}\/|file:)/.test(spec)) {
        return nextResolve(`${spec}.ts`, context);
      }
      throw err;
    }
  },
});

const { computeMetricsFromEntries } = await import("./performance-recompute.ts");
type TimeEntryRow = import("./performance-recompute.ts").TimeEntryRow;

function entry(
  date: string,
  type: "scheduled" | "worked",
  inTime = "09:00:00"
): TimeEntryRow {
  return {
    entry_date: date,
    entry_type: type,
    in_time: inTime,
  } as unknown as TimeEntryRow;
}

const CAP = { scheduledScoredThrough: "2026-08-31" };

test("a removed, unpunched scheduled day is DROPPED from both sides — not an absence", () => {
  const m = computeMetricsFromEntries(
    [
      entry("2026-06-01", "scheduled"),
      entry("2026-06-01", "worked"),
      entry("2026-06-02", "scheduled"), // removed (not in liveDates), unpunched → dropped
      entry("2026-06-03", "scheduled"), // live, unpunched → a REAL absence
    ],
    {
      ...CAP,
      removedShifts: {
        mirrorCoverageStart: "2026-06-01",
        liveDates: new Set(["2026-06-01", "2026-06-03"]),
      },
    }
  );
  assert.equal(m.scheduled_count, 2); // the removed day is in NO denominator
  assert.equal(m.attended_count, 1);
  assert.equal(m.missed_count, 1);
  assert.equal(m.attendance_pct, 50);
});

test("§2 THE TRAP: a removed-but-PUNCHED day counts ATTENDED — a punch outranks a schedule in both directions", () => {
  const m = computeMetricsFromEntries(
    [
      entry("2026-06-02", "scheduled"), // removed from the mirror…
      entry("2026-06-02", "worked"), // …but punched: swapped away, turned up anyway
    ],
    {
      ...CAP,
      removedShifts: {
        mirrorCoverageStart: "2026-06-01",
        liveDates: new Set<string>(), // nothing live — the shift is gone
      },
    }
  );
  assert.equal(m.attended_count, 1, "worked-but-removed is ATTENDED, never dropped");
  assert.equal(m.scheduled_count, 1);
  assert.equal(m.attendance_pct, 100);
});

test("§3: dates before the mirror's coverage stay in the denominator uncorrected", () => {
  const m = computeMetricsFromEntries(
    [entry("2026-05-15", "scheduled")], // before coverage; absent from mirror by construction
    {
      ...CAP,
      removedShifts: {
        mirrorCoverageStart: "2026-06-01",
        liveDates: new Set<string>(),
      },
    }
  );
  assert.equal(m.missed_count, 1, "cannot judge → stays a miss, do not infer");
  assert.equal(m.scheduled_count, 1);
});

test("§3: a location with no mirror rows corrects nothing (coverage null)", () => {
  const m = computeMetricsFromEntries([entry("2026-06-02", "scheduled")], {
    ...CAP,
    removedShifts: { mirrorCoverageStart: null, liveDates: new Set<string>() },
  });
  assert.equal(m.missed_count, 1);
});

test("§3: an employee the mirror cannot judge (liveDates null) corrects nothing", () => {
  const m = computeMetricsFromEntries([entry("2026-06-02", "scheduled")], {
    ...CAP,
    removedShifts: { mirrorCoverageStart: "2026-06-01", liveDates: null },
  });
  assert.equal(m.missed_count, 1);
});

test("no evidence passed → behaviour is byte-identical to before the correction", () => {
  const entries = [
    entry("2026-06-01", "scheduled"),
    entry("2026-06-02", "scheduled"),
    entry("2026-06-01", "worked"),
  ];
  const without = computeMetricsFromEntries(entries, CAP);
  assert.equal(without.scheduled_count, 2);
  assert.equal(without.missed_count, 1);
  assert.equal(without.attendance_pct, 50);
});
