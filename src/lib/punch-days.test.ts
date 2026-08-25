/**
 * Pins for the EPD -> CP punch-day feed (frozen-quarter spec addendum
 * 2026-08-25 §4b). The marker is the whole build:
 *
 *  1. A successful run whose finished_at falls early in the store-local
 *     morning must NOT advance coverage into that day — tonight's 03:55
 *     labor run is the fixture (window_end over-claims; the store clock
 *     bounds it).
 *  2. A location whose punch source differs from the majority resolves
 *     against its OWN source — NOLA (cake_timesheets) is the fixture, a
 *     full day behind the Toast estate.
 *  3. Any per-store table's row count is the number of locations — read
 *     from the locations list, never a hardcoded 8. "Seven stores" has
 *     been wrong about the eighth three separate times today.
 *
 * Module loading: same registerHooks shim as performance-recompute.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const {
  addDaysIso,
  buildCoverageEntry,
  coverageThrough,
  punchDayDates,
  punchSourceForActuals,
} = await import("./punch-days.ts");

// ---------------------------------------------------------------------------
// Pin 1 — the store clock bounds coverage, not window_end.
// ---------------------------------------------------------------------------

test("tonight's fixture: 09:55 UTC success (03:55 in Denver) does NOT advance coverage into today", () => {
  // The 2026-08-25 09:55 UTC toast_labor run succeeded at all seven Toast
  // stores with window_end = 2026-08-25 — before any store opened. A
  // window_end marker would report today as covered-with-zero-punches.
  const through = coverageThrough(
    "2026-08-25T09:55:00Z",
    "2026-08-25T09:55:00Z",
    "America/Denver"
  );
  assert.equal(through, "2026-08-24");
});

test("an evening-finished run still yields yesterday — the local day must END before it is answerable", () => {
  // 23:30 store-local on the 24th: the 24th is still in progress.
  const through = coverageThrough(
    "2026-08-25T05:30:00Z",
    "2026-08-25T05:30:00Z",
    "America/Denver" // 23:30 on 08-24 local
  );
  assert.equal(through, "2026-08-23");
});

test("window_end earlier than the clock bound wins (LEAST) — a clamped fetch never over-claims", () => {
  const through = coverageThrough(
    "2026-08-20T00:00:00Z",
    "2026-08-25T20:00:00Z",
    "America/Denver"
  );
  // local date of window_end = 2026-08-19 (18:00 on 08-19 in MDT) < 08-24.
  assert.equal(through, "2026-08-19");
});

// ---------------------------------------------------------------------------
// Pin 2 — per-location source resolution; NOLA is the fixture.
// ---------------------------------------------------------------------------

test("NOLA resolves against its OWN source and clock: cake_timesheets, a day behind the Toast estate", () => {
  assert.equal(punchSourceForActuals("cake"), "cake_timesheets");
  // Measured 2026-08-25: CAKE last succeeded 2026-08-24 14:11 UTC (09:11 in
  // New Orleans) → coverage_through 2026-08-23, while Toast stores read
  // 2026-08-24.
  const nola = buildCoverageEntry(
    "NOLA",
    "cake",
    { window_end: "2026-08-24T14:11:00Z", finished_at: "2026-08-24T14:11:00Z" },
    "America/Chicago",
    "2026-08-01",
    "2026-08-25"
  );
  assert.equal(nola.punch_source, "cake_timesheets");
  assert.equal(nola.coverage_through, "2026-08-23");
  assert.deepEqual(nola.answerable, { from: "2026-08-01", to: "2026-08-23" });
  assert.deepEqual(nola.not_answerable, { from: "2026-08-24", to: "2026-08-25" });
});

test("source map is exhaustive over actuals_source and null-safe", () => {
  assert.equal(punchSourceForActuals("toast"), "toast_labor");
  assert.equal(punchSourceForActuals("7shifts"), "7shifts_time");
  assert.equal(punchSourceForActuals(null), null);
  assert.equal(punchSourceForActuals("csv"), null);
});

test("no source / no successful run are EXPLICIT states with the whole range not answerable — absence is never an encoding", () => {
  const noSource = buildCoverageEntry(
    "XX", null, null, "America/Denver", "2026-08-01", "2026-08-25"
  );
  assert.equal(noSource.state, "no_punch_source");
  assert.equal(noSource.coverage_through, null);
  assert.equal(noSource.answerable, null);
  assert.deepEqual(noSource.not_answerable, { from: "2026-08-01", to: "2026-08-25" });

  // A failed nightly must produce "cannot answer", not a silent green
  // light — the caller only feeds status='success' runs in, so no run at
  // all = no_successful_run.
  const noRun = buildCoverageEntry(
    "CPD", "toast", null, "America/Denver", "2026-08-01", "2026-08-25"
  );
  assert.equal(noRun.state, "no_successful_run");
  assert.equal(noRun.answerable, null);
  assert.deepEqual(noRun.not_answerable, { from: "2026-08-01", to: "2026-08-25" });
});

test("a range entirely beyond coverage is fully not-answerable, never an empty set", () => {
  const entry = buildCoverageEntry(
    "CPD",
    "toast",
    { window_end: "2026-08-25T09:55:00Z", finished_at: "2026-08-25T09:55:00Z" },
    "America/Denver",
    "2026-08-25",
    "2026-08-26"
  );
  assert.equal(entry.state, "ok");
  assert.equal(entry.coverage_through, "2026-08-24");
  assert.equal(entry.answerable, null);
  assert.deepEqual(entry.not_answerable, { from: "2026-08-25", to: "2026-08-26" });
});

test("a fully-covered range carries not_answerable: null — nothing withheld, nothing implied", () => {
  const entry = buildCoverageEntry(
    "CPD",
    "toast",
    { window_end: "2026-08-25T09:55:00Z", finished_at: "2026-08-25T09:55:00Z" },
    "America/Denver",
    "2026-08-01",
    "2026-08-20"
  );
  assert.deepEqual(entry.answerable, { from: "2026-08-01", to: "2026-08-20" });
  assert.equal(entry.not_answerable, null);
});

test("exact boundaries: coverage_through == rangeTo is fully answerable; == rangeFrom - 1 is fully not", () => {
  const run = {
    window_end: "2026-08-25T09:55:00Z",
    finished_at: "2026-08-25T09:55:00Z",
  }; // coverage_through 2026-08-24 in Denver
  const exact = buildCoverageEntry(
    "CPD", "toast", run, "America/Denver", "2026-08-01", "2026-08-24"
  );
  assert.deepEqual(exact.answerable, { from: "2026-08-01", to: "2026-08-24" });
  assert.equal(exact.not_answerable, null);

  const justPast = buildCoverageEntry(
    "CPD", "toast", run, "America/Denver", "2026-08-25", "2026-08-25"
  );
  assert.equal(justPast.answerable, null);
  assert.deepEqual(justPast.not_answerable, { from: "2026-08-25", to: "2026-08-25" });
});

// ---------------------------------------------------------------------------
// Pin 3 — the per-store table's row count is the number of locations.
// ---------------------------------------------------------------------------

test("coverage table row count == locations count, READ from the fixture — never a hardcoded 8", () => {
  // The fixture deliberately has nine rows (the estate plus one) so a
  // hardcoded 8 fails in BOTH directions.
  const fixtureLocations = [
    { code: "CPD", source: "toast", tz: "America/Denver" },
    { code: "COS", source: "toast", tz: "America/Denver" },
    { code: "DTD", source: "toast", tz: "America/Denver" },
    { code: "FCOL", source: "toast", tz: "America/Denver" },
    { code: "HRANCH", source: "toast", tz: "America/Denver" },
    { code: "LONGM", source: "toast", tz: "America/Denver" },
    { code: "HOU", source: "toast", tz: "America/Chicago" },
    { code: "NOLA", source: "cake", tz: "America/Chicago" },
    { code: "NEWSTORE", source: null, tz: "America/Denver" },
  ];
  const table = fixtureLocations.map((l) =>
    buildCoverageEntry(l.code, l.source, null, l.tz, "2026-08-01", "2026-08-25")
  );
  assert.equal(table.length, fixtureLocations.length);
  // Every location present by code — an omitted store is the recurring
  // defect this pin exists to make impossible.
  assert.deepEqual(
    table.map((e) => e.location_code).sort(),
    fixtureLocations.map((l) => l.code).sort()
  );
});

// ---------------------------------------------------------------------------
// Overnight day-boundary rule.
// ---------------------------------------------------------------------------

test("a shift ending after local midnight marks BOTH dates; a same-day shift marks one", () => {
  assert.deepEqual(
    punchDayDates("2026-08-24T22:00:00", "2026-08-25T02:00:00"),
    ["2026-08-24", "2026-08-25"]
  );
  assert.deepEqual(
    punchDayDates("2026-08-24T09:00:00", "2026-08-24T17:00:00"),
    ["2026-08-24"]
  );
  assert.deepEqual(punchDayDates("2026-08-24T09:00:00", null), ["2026-08-24"]);
});

test("addDaysIso is DST-immune date arithmetic", () => {
  assert.equal(addDaysIso("2026-08-25", -1), "2026-08-24");
  assert.equal(addDaysIso("2026-03-01", -1), "2026-02-28");
  assert.equal(addDaysIso("2026-11-01", 1), "2026-11-02"); // US DST fall-back day
});

// ---------------------------------------------------------------------------
// Route contract pins (text-level, repo convention).
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const routeSrc = read("src/app/api/identity/punch-days/route.ts");

test("route: SCORES_FEED_TOKEN bearer + the identity-feed envelope, riding the /api/identity carve-out", () => {
  assert.match(routeSrc, /SCORES_FEED_TOKEN/);
  for (const field of ["limit", "offset", "count", "has_more"]) {
    assert.match(routeSrc, new RegExp(field), `pagination carries ${field}`);
  }
});

test("route: coverage derives from the locations READ — no hardcoded store table, no LOCATION_CODES constant", () => {
  assert.match(routeSrc, /from\("locations"\)/);
  assert.doesNotMatch(routeSrc, /LOCATION_CODES/);
  // No store code literals anywhere in the route.
  assert.doesNotMatch(routeSrc, /"(CPD|COS|DTD|FCOL|HRANCH|LONGM|HOU|NOLA)"/);
});

test("route: only status='success' runs advance the mark, per-location source, explicit no_punch_source", () => {
  assert.match(routeSrc, /eq\("status", "success"\)/);
  assert.match(routeSrc, /punchSourceForActuals/);
  assert.match(routeSrc, /no_punch_source|buildCoverageEntry/);
});

test("route: unanswerable dates never contribute punch_days (the answer set cannot contradict the coverage claim)", () => {
  assert.match(routeSrc, /answerableThrough/);
  assert.match(routeSrc, /day > answerableThrough/);
});

test("route: punch source of record is v_worked_intervals — the flip's single worked-time view", () => {
  assert.match(routeSrc, /from\("v_worked_intervals"\)/);
  assert.doesNotMatch(routeSrc, /from\("toast_time_entries"\)/);
  assert.doesNotMatch(routeSrc, /from\("time_entries"\)/);
});

test("route: interval paging carries a TOTAL order — the view emits multiple rows per (employee, date)", () => {
  // Without the shift tiebreakers, offset paging can skip or duplicate rows
  // at page boundaries (Codex should-fix 2026-08-25; the #36 lesson).
  const q = routeSrc.indexOf('from("v_worked_intervals")');
  const block = routeSrc.slice(q, routeSrc.indexOf(".range(", q));
  for (const key of ["employee_id", "entry_date", "shift_start", "shift_end"]) {
    assert.ok(block.includes(`order("${key}"`), `interval paging orders by ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Wire-shape pins — cross-project contract weight, like scores-feed-contract.
// ---------------------------------------------------------------------------

test("wire: top-level envelope is exactly range + coverage + data + pagination (extension is deliberate, pinned)", () => {
  // The identity envelope (data + pagination) deliberately extended with
  // range + coverage — coverage is the feed's raison d'être. Pinning the
  // extension is what separates it from drift.
  const ret = routeSrc.indexOf("return NextResponse.json({\n      range:");
  assert.ok(ret > 0, "success response starts with the pinned envelope");
  const block = routeSrc.slice(ret, routeSrc.indexOf("});", ret));
  for (const key of ["range:", "coverage,", "data: pageRows", "pagination:"]) {
    assert.ok(block.includes(key), `envelope carries ${key}`);
  }
});

test("wire: coverage entry fields are the CoverageEntry contract — every field, no omissions", () => {
  const libSrc = read("src/lib/punch-days.ts");
  const iface = libSrc.indexOf("export interface CoverageEntry");
  const block = libSrc.slice(iface, libSrc.indexOf("\n}", iface));
  for (const field of [
    "location_code",
    "punch_source",
    "coverage_through",
    "state",
    "answerable",
    "not_answerable",
  ]) {
    assert.ok(block.includes(field), `CoverageEntry carries ${field}`);
  }
  assert.match(block, /"ok" \| "no_punch_source" \| "no_successful_run"/);
});

test("wire: data rows carry both CP join keys (employee_code AND seven_shifts_user_id) plus location + punch_days", () => {
  const iface = routeSrc.indexOf("interface DataRow");
  const block = routeSrc.slice(iface, routeSrc.indexOf("\n    }", iface));
  for (const field of [
    "employee_code",
    "employee_name",
    "seven_shifts_user_id",
    "location_code",
    "punch_days",
  ]) {
    assert.ok(block.includes(field), `data row carries ${field}`);
  }
});
