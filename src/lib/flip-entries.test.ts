/**
 * Unit tests for mergeEffectiveEntries — the flip's TS semantics (flip spec
 * 2026-08-24 §3, built 2026-08-25). The load-bearing behaviours:
 *
 *  - SCHEDULED is store+day-conditional: on a day the pruned direct feed
 *    covers, it is authoritative (an unpruned time_entries scheduled row
 *    with no direct counterpart is the deletion-accumulation artifact and
 *    must NOT count); on a day it doesn't cover, time_entries scheduled is
 *    the fallback (pre-June history, ingest outages).
 *  - WORKED is go-live-split, exactly as v_worked_intervals: Toast punches
 *    on/after go-live (absence of a punch IS absence — a leftover 7shifts
 *    worked row does not resurrect the day), time_entries before.
 *  - Non-Toast stores pass time_entries through untouched.
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

const { mergeEffectiveEntries } = await import("./flip-entries.ts");

type Row = { entry_date: string; entry_type: "scheduled" | "worked"; in_time: string | null };

function te(date: string, type: "scheduled" | "worked", time: string | null): Row {
  return { entry_date: date, entry_type: type, in_time: time };
}

test("non-Toast stores pass time_entries through untouched — NOLA by construction", () => {
  const rows = [te("2026-07-01", "scheduled", "09:00:00"), te("2026-07-01", "worked", "09:02:00")];
  const out = mergeEffectiveEntries({
    isToast: false,
    isMapped: true,
    directFeedFirstDate: "2026-01-01",
    goLive: null,
    directFeedDays: new Set(["2026-07-01"]),
    directStartByDate: new Map([["2026-07-01", "08:00:00"]]),
    toastInByDate: new Map([["2026-07-01", "08:01:00"]]),
    timeEntries: rows,
  });
  assert.deepEqual(out, rows, "flip sources must be ignored entirely at a non-Toast store");
});

test("scheduled: the direct feed is authoritative on days it covers — the artifact does not count", () => {
  // The 139 recovered employee-days: a time_entries scheduled row with no
  // direct-feed counterpart on a covered day is a deleted-upstream shift.
  const out = mergeEffectiveEntries({
    isToast: true,
    isMapped: true,
    directFeedFirstDate: "2026-01-01",
    goLive: "2026-07-01",
    directFeedDays: new Set(["2026-07-10", "2026-07-11"]),
    directStartByDate: new Map([["2026-07-10", "09:00:00"]]),
    toastInByDate: new Map(),
    timeEntries: [
      te("2026-07-10", "scheduled", "10:00:00"), // superseded by direct feed (09:00 wins)
      te("2026-07-11", "scheduled", "11:00:00"), // covered day, NO direct shift → artifact, dropped
    ],
  });
  assert.deepEqual(out, [te("2026-07-10", "scheduled", "09:00:00")]);
});

test("scheduled: a day the direct feed does NOT cover falls back to time_entries — history and outages", () => {
  // Houston's April: direct-feed history floor postdates it; the only
  // schedule evidence is time_entries. The day-conditional method rule.
  const out = mergeEffectiveEntries({
    isToast: true,
    isMapped: true,
    directFeedFirstDate: "2026-01-01",
    goLive: "2026-04-30",
    directFeedDays: new Set(["2026-06-02"]),
    directStartByDate: new Map([["2026-06-02", "08:30:00"]]),
    toastInByDate: new Map(),
    timeEntries: [te("2026-04-15", "scheduled", "09:00:00")],
  });
  assert.deepEqual(out, [
    te("2026-04-15", "scheduled", "09:00:00"),
    te("2026-06-02", "scheduled", "08:30:00"),
  ]);
});

test("worked: the go-live split — Toast owns on/after, time_entries owns before, no resurrection", () => {
  const out = mergeEffectiveEntries({
    isToast: true,
    isMapped: true,
    directFeedFirstDate: "2026-01-01",
    goLive: "2026-07-01",
    directFeedDays: new Set(),
    directStartByDate: new Map(),
    toastInByDate: new Map([["2026-07-05", "08:58:00"]]),
    timeEntries: [
      te("2026-06-20", "worked", "09:01:00"), // pre-go-live history — kept
      te("2026-07-05", "worked", "09:30:00"), // post-go-live 7shifts row — Toast's 08:58 wins
      te("2026-07-06", "worked", "09:05:00"), // post-go-live, NO Toast punch → absence, dropped
    ],
  });
  assert.deepEqual(out, [
    te("2026-06-20", "worked", "09:01:00"),
    te("2026-07-05", "worked", "08:58:00"),
  ]);
});

test("null go-live at a Toast store: worked keeps time_entries entirely (the §1 load-bearing pair)", () => {
  // §1's loud failure guarantees no Toast rows can be ingested for such a
  // store, so keeping time_entries is lossless — mirrors v_worked_intervals.
  const out = mergeEffectiveEntries({
    isToast: true,
    isMapped: true,
    directFeedFirstDate: "2026-01-01",
    goLive: null,
    directFeedDays: new Set(),
    directStartByDate: new Map(),
    toastInByDate: new Map([["2026-07-05", "08:00:00"]]),
    timeEntries: [te("2026-07-05", "worked", "09:00:00")],
  });
  assert.deepEqual(out, [te("2026-07-05", "worked", "09:00:00")]);
});

test("punctuality inputs: direct-feed start vs Toast punch-in land as scheduled/worked pairs", () => {
  // The semantic change the flip verification reports separately: on-time
  // now compares a Toast clock-in against the direct feed's start.
  const out = mergeEffectiveEntries({
    isToast: true,
    isMapped: true,
    directFeedFirstDate: "2026-01-01",
    goLive: "2026-07-01",
    directFeedDays: new Set(["2026-07-10"]),
    directStartByDate: new Map([["2026-07-10", "09:00:00"]]),
    toastInByDate: new Map([["2026-07-10", "09:02:00"]]),
    timeEntries: [],
  });
  assert.deepEqual(out, [
    te("2026-07-10", "scheduled", "09:00:00"),
    te("2026-07-10", "worked", "09:02:00"),
  ]);
});

// ---- Build 2 (2026-08-25): the unmapped-employee null ----------------------
// The test that would have caught the sixth occurrence: five unmapped
// employees scored 0% with their punches sitting in the unmatched queue.

const { computeMetricsFromEntries } = await import("./performance-recompute.ts");

test("BUILD 2 PIN: unmapped at a Toast store, scheduled post-go-live, no punches → attendance null, NEVER 0", () => {
  const merged = mergeEffectiveEntries({
    isToast: true,
    isMapped: false,
    directFeedFirstDate: "2026-01-01",
    goLive: "2026-07-01",
    directFeedDays: new Set(["2026-07-10", "2026-07-11"]),
    directStartByDate: new Map([
      ["2026-07-10", "09:00:00"],
      ["2026-07-11", "09:00:00"],
    ]),
    toastInByDate: new Map(), // unmapped: punches unobservable by construction
    timeEntries: [],
  });
  // Blind days emit nothing — not scheduled, not worked.
  assert.deepEqual(merged, []);
  const m = computeMetricsFromEntries(merged, {
    scheduledScoredThrough: "2026-07-31",
    punchesTimeClock: true,
  });
  assert.equal(m.attendance_pct, null, "cannot-see must read null");
  assert.equal(m.on_time_pct, null);
  assert.equal(m.scheduled_count, 0);
});

test("Build 2: pre-go-live days still score for an unmapped employee — blindness is post-go-live only", () => {
  const merged = mergeEffectiveEntries({
    isToast: true,
    isMapped: false,
    directFeedFirstDate: "2026-01-01",
    goLive: "2026-07-01",
    directFeedDays: new Set(["2026-07-10"]),
    directStartByDate: new Map([["2026-07-10", "09:00:00"]]),
    toastInByDate: new Map(),
    timeEntries: [
      te("2026-06-15", "scheduled", "09:00:00"),
      te("2026-06-15", "worked", "08:59:00"),
    ],
  });
  assert.deepEqual(merged, [
    te("2026-06-15", "scheduled", "09:00:00"),
    te("2026-06-15", "worked", "08:59:00"),
  ]);
});

test("Build 2 scope: a MAPPED employee with zero punches keeps scoring absence — the Sierra Estrada rule", () => {
  // A mapping that exists means EPD can see; seeing nothing is a finding
  // for the anomaly list, not a null.
  const merged = mergeEffectiveEntries({
    isToast: true,
    isMapped: true,
    directFeedFirstDate: "2026-01-01",
    goLive: "2026-07-01",
    directFeedDays: new Set(["2026-07-10"]),
    directStartByDate: new Map([["2026-07-10", "09:00:00"]]),
    toastInByDate: new Map(),
    timeEntries: [],
  });
  assert.deepEqual(merged, [te("2026-07-10", "scheduled", "09:00:00")]);
  const m = computeMetricsFromEntries(merged, {
    scheduledScoredThrough: "2026-07-31",
    punchesTimeClock: true,
  });
  assert.equal(m.attendance_pct, 0, "mapped + no punches = real absence, scored");
});

// ---- Q2-blocker fix (2026-08-25): employee-level direct-feed presence ------

test("KEVIN MONTIE PIN: scheduled days before the employee's first direct-feed row survive on store-covered days", () => {
  // COS coverage begins 06-01; Kevin's feed record begins 07-07. His June
  // time_entries scheduled rows are schedule-coverage blindness, not
  // deletion artifacts — they must keep scoring (60%, not a confident 0%).
  const merged = mergeEffectiveEntries({
    isToast: true,
    isMapped: true,
    directFeedFirstDate: "2026-07-07",
    goLive: "2026-07-07",
    directFeedDays: new Set(["2026-06-10", "2026-06-11", "2026-07-10"]),
    directStartByDate: new Map([["2026-07-10", "09:00:00"]]),
    toastInByDate: new Map(),
    timeEntries: [
      te("2026-06-10", "scheduled", "09:00:00"), // store-covered, pre-presence → KEPT
      te("2026-06-10", "worked", "09:01:00"),    // pre-go-live worked → kept
      te("2026-06-11", "scheduled", "10:00:00"), // store-covered, pre-presence → KEPT
    ],
  });
  assert.deepEqual(merged, [
    te("2026-06-10", "scheduled", "09:00:00"),
    te("2026-06-10", "worked", "09:01:00"),
    te("2026-06-11", "scheduled", "10:00:00"),
    te("2026-07-10", "scheduled", "09:00:00"), // on/after presence: direct feed authoritative
  ]);
});

test("the artifact-drop does NOT regress for an employee WITH presence — the 139 recovered days", () => {
  const merged = mergeEffectiveEntries({
    isToast: true,
    isMapped: true,
    directFeedFirstDate: "2026-06-01",
    goLive: "2026-07-01",
    directFeedDays: new Set(["2026-07-11"]),
    directStartByDate: new Map(), // covered day, no direct shift for them
    toastInByDate: new Map(),
    timeEntries: [te("2026-07-11", "scheduled", "11:00:00")], // the artifact
  });
  assert.deepEqual(merged, [], "a present employee's artifact row must still drop");
});

test("the boundary day itself — the employee's first direct-feed date — is authoritative", () => {
  const merged = mergeEffectiveEntries({
    isToast: true,
    isMapped: true,
    directFeedFirstDate: "2026-07-07",
    goLive: "2026-07-01",
    directFeedDays: new Set(["2026-07-07"]),
    directStartByDate: new Map([["2026-07-07", "08:30:00"]]),
    toastInByDate: new Map(),
    timeEntries: [te("2026-07-07", "scheduled", "10:00:00")], // superseded by the feed
  });
  assert.deepEqual(merged, [te("2026-07-07", "scheduled", "08:30:00")]);
});

test("an employee with NO direct-feed presence keeps time_entries scheduled on covered days", () => {
  const merged = mergeEffectiveEntries({
    isToast: true,
    isMapped: true,
    directFeedFirstDate: null,
    goLive: "2026-07-01",
    directFeedDays: new Set(["2026-07-11"]),
    directStartByDate: new Map(),
    toastInByDate: new Map([["2026-07-11", "09:00:00"]]),
    timeEntries: [te("2026-07-11", "scheduled", "09:00:00")],
  });
  assert.deepEqual(merged, [
    te("2026-07-11", "scheduled", "09:00:00"),
    te("2026-07-11", "worked", "09:00:00"),
  ]);
});
