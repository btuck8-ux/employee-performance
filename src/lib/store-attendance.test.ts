/**
 * Unit tests for the pure store-wide combiner (mig 057). The load-bearing
 * assertions: rates come from SUMMED numerators/denominators (never averaged
 * per-employee percentages), GMs stay IN the all-staff figure, and both
 * figures are computed — neither replaces the other.
 *
 * Module loading: same resolve-hook arrangement as
 * performance-recompute.test.ts (extensionless "./" imports + "@/" alias
 * under the bare type-stripping runner).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

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

const { combineStoreMetrics } = await import("./store-attendance.ts");

interface Counts {
  scheduled: number;
  attended: number;
  onTime: number;
  onTimeGrace: number;
}

function metricsOf(c: Counts) {
  return {
    attendance_pct: c.scheduled > 0 ? (c.attended / c.scheduled) * 100 : null,
    on_time_pct: c.attended > 0 ? (c.onTime / c.attended) * 100 : null,
    on_time_grace_pct: c.attended > 0 ? (c.onTimeGrace / c.attended) * 100 : null,
    covered_shifts: 0,
    scheduled_count: c.scheduled,
    attended_count: c.attended,
    missed_count: c.scheduled - c.attended,
    on_time_count: c.onTime,
    on_time_grace_count: c.onTimeGrace,
    cover_dominated: false,
  };
}

test("rates are recomputed from summed parts — never averaged percentages", () => {
  // 90% on a big denominator + 50% on a tiny one: the averaged-percentages
  // answer would be 70; the summed answer is 46/52.
  const out = combineStoreMetrics([
    {
      isGeneralManager: false,
      metrics: metricsOf({ scheduled: 50, attended: 45, onTime: 40, onTimeGrace: 44 }),
    },
    {
      isGeneralManager: false,
      metrics: metricsOf({ scheduled: 2, attended: 1, onTime: 0, onTimeGrace: 1 }),
    },
  ]);
  assert.equal(out.allStaff.parts.scheduled, 52);
  assert.equal(out.allStaff.parts.attended, 46);
  assert.ok(Math.abs((out.allStaff.attendancePct ?? 0) - (46 / 52) * 100) < 1e-9);
  // Punctuality denominators are attended shifts.
  assert.ok(Math.abs((out.allStaff.onTimePct ?? 0) - (40 / 46) * 100) < 1e-9);
});

test("GMs stay IN all-staff and OUT of excluding-management — both figures present", () => {
  const gm = {
    isGeneralManager: true,
    metrics: metricsOf({ scheduled: 40, attended: 40, onTime: 38, onTimeGrace: 40 }),
  };
  const staff = {
    isGeneralManager: false,
    metrics: metricsOf({ scheduled: 60, attended: 42, onTime: 30, onTimeGrace: 36 }),
  };
  const out = combineStoreMetrics([gm, staff]);
  assert.equal(out.gmCount, 1);
  assert.equal(out.allStaff.parts.scheduled, 100);
  assert.equal(out.allStaff.parts.attended, 82);
  assert.equal(out.excludingManagement.parts.scheduled, 60);
  assert.equal(out.excludingManagement.parts.attended, 42);
  // The DTD/HRANCH shape: a perfectly-attending GM means excluding
  // management makes the store look WORSE — the reason exclusion is
  // reported alongside, not applied.
  assert.ok(
    (out.excludingManagement.attendancePct ?? 0) < (out.allStaff.attendancePct ?? 0)
  );
});

test("zero-denominator sides read null, never 0 — and a gated non-puncher adds no weight", () => {
  // A non-puncher gated by punchesTimeClockForPeriod arrives with all-zero
  // counts (the mig 056 early return): no denominators either way.
  const excludedNonPuncher = {
    isGeneralManager: true,
    metrics: metricsOf({ scheduled: 0, attended: 0, onTime: 0, onTimeGrace: 0 }),
  };
  const out = combineStoreMetrics([excludedNonPuncher]);
  assert.equal(out.allStaff.attendancePct, null);
  assert.equal(out.allStaff.onTimePct, null);
  assert.equal(out.excludingManagement.attendancePct, null);
  assert.equal(out.allStaff.parts.employees, 0);

  const empty = combineStoreMetrics([]);
  assert.equal(empty.allStaff.attendancePct, null);
  assert.equal(empty.gmCount, 0);
});
