/**
 * Unit tests for the pure shift/punctuality math in performance-recompute.ts
 * (computeMetricsFromEntries + the ON_TIME_GRACE_MINUTES boundary).
 *
 * Module loading: performance-recompute.ts imports `./quarter` (extensionless)
 * and `@/lib/format` (tsconfig path alias), neither of which Node's ESM
 * resolver understands under the bare type-stripping test runner. A small
 * synchronous resolve hook (module.registerHooks, Node ≥ 23.5) maps `@/…` to
 * `src/…` and retries failed relative resolutions with a `.ts` suffix, then
 * the module is loaded via dynamic import. node --test isolates each test
 * file in its own process, so the hook cannot leak into other test files.
 *
 * computeMetricsForRange is deliberately NOT covered here: it fans out over
 * eight tables and three RPCs with heterogeneous PostgREST chain shapes
 * (.eq/.gte/.lte, .order/.limit/.maybeSingle, .in/.range, .rpc), so any fake
 * supabase would be a large mock coupled to query construction order —
 * exactly the fragile kind this suite avoids. Its scoring math is covered
 * via computeMetricsFromEntries plus the customer-service-score and
 * total-impact-score tests it delegates to.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// @types/node v20 predates registerHooks (runtime-present on Node 24), so
// type the surface we use ourselves.
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
      // tsconfig maps "@/*" → "./src/*"; this file lives in src/lib/.
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
  computeMetricsFromEntries,
  punchesTimeClockForPeriod,
  ON_TIME_GRACE_MINUTES,
} = await import("./performance-recompute.ts");

type EntryType = "scheduled" | "worked";
interface Entry {
  entry_date: string;
  entry_type: EntryType;
  in_time: string | null;
}

function entry(date: string, type: EntryType, inTime: string | null): Entry {
  return { entry_date: date, entry_type: type, in_time: inTime };
}

const CAP = { scheduledScoredThrough: "2026-06-30" };

function assertClose(actual: number | null, expected: number, label = "value") {
  assert.ok(actual !== null, `${label} is null, expected ~${expected}`);
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label}: ${actual} !~ ${expected}`
  );
}

test("attendance %: attended / (attended + missed) over scheduled days", () => {
  const m = computeMetricsFromEntries(
    [
      entry("2026-06-01", "scheduled", "09:00:00"),
      entry("2026-06-02", "scheduled", "09:00:00"),
      entry("2026-06-03", "scheduled", "09:00:00"),
      entry("2026-06-04", "scheduled", "09:00:00"), // no worked → missed
      entry("2026-06-01", "worked", "09:00:00"),
      entry("2026-06-02", "worked", "09:10:00"),
      entry("2026-06-03", "worked", "08:50:00"),
    ],
    CAP
  );
  assert.equal(m.scheduled_count, 4);
  assert.equal(m.attended_count, 3);
  assert.equal(m.missed_count, 1);
  assert.equal(m.attendance_pct, 75);
  // punctuality: 06-01 exactly on time, 06-03 early → strict 2; 06-02 is
  // 10 min late → outside grace too.
  assert.equal(m.on_time_count, 2);
  assert.equal(m.on_time_grace_count, 2);
  assertClose(m.on_time_pct, (2 / 3) * 100, "on_time_pct");
  assertClose(m.on_time_grace_pct, (2 / 3) * 100, "on_time_grace_pct");
  assert.equal(m.covered_shifts, 0);
});

test("grace boundary: scheduled+3 min counts as on-time, +4 does not", () => {
  assert.equal(ON_TIME_GRACE_MINUTES, 3);
  const m = computeMetricsFromEntries(
    [
      entry("2026-06-01", "scheduled", "09:00:00"),
      entry("2026-06-02", "scheduled", "09:00:00"),
      entry("2026-06-03", "scheduled", "09:00:00"),
      entry("2026-06-04", "scheduled", "09:00:00"),
      entry("2026-06-01", "worked", "09:00:00"), // exact → strict + grace
      entry("2026-06-02", "worked", "09:03:00"), // +3 → grace only (<=)
      entry("2026-06-03", "worked", "09:04:00"), // +4 → neither
      // Seconds are truncated by timeToMinutes — 09:03:59 is still minute 543,
      // so it lands inside the grace window.
      entry("2026-06-04", "worked", "09:03:59"),
    ],
    CAP
  );
  assert.equal(m.attended_count, 4);
  assert.equal(m.on_time_count, 1);
  assert.equal(m.on_time_grace_count, 3);
  assertClose(m.on_time_pct, 25, "on_time_pct");
  assertClose(m.on_time_grace_pct, 75, "on_time_grace_pct");
});

test("early punch is strictly on-time; HH:MM (no seconds) parses", () => {
  const m = computeMetricsFromEntries(
    [
      entry("2026-06-01", "scheduled", "09:00"),
      entry("2026-06-01", "worked", "08:45"),
    ],
    CAP
  );
  assert.equal(m.on_time_count, 1);
  assert.equal(m.on_time_grace_count, 1);
  assert.equal(m.on_time_pct, 100);
});

test("null/malformed punch times: shift attends but never counts on-time", () => {
  const m = computeMetricsFromEntries(
    [
      entry("2026-06-01", "scheduled", null), // scheduled in_time missing
      entry("2026-06-01", "worked", "09:00:00"),
      entry("2026-06-02", "scheduled", "09:00:00"),
      entry("2026-06-02", "worked", null), // worked punch missing
      entry("2026-06-03", "scheduled", "09:00:00"),
      entry("2026-06-03", "worked", "9:00"), // malformed (single-digit hour)
    ],
    CAP
  );
  assert.equal(m.attended_count, 3);
  assert.equal(m.attendance_pct, 100);
  assert.equal(m.on_time_count, 0);
  assert.equal(m.on_time_grace_count, 0);
  // Contract: shifts with unparseable punches stay in the attended
  // denominator, so the rate is 0 — not null.
  assert.equal(m.on_time_pct, 0);
  assert.equal(m.on_time_grace_pct, 0);
});

test("scheduledScoredThrough cap: dates after the cap are not scored", () => {
  const m = computeMetricsFromEntries(
    [
      entry("2026-06-10", "scheduled", "09:00:00"),
      entry("2026-06-10", "worked", "09:00:00"),
      entry("2026-06-20", "scheduled", "09:00:00"), // after cap → ignored
      entry("2026-06-16", "scheduled", "09:00:00"), // after cap → ignored
    ],
    { scheduledScoredThrough: "2026-06-15" }
  );
  assert.equal(m.scheduled_count, 1);
  assert.equal(m.attended_count, 1);
  assert.equal(m.missed_count, 0); // future shifts must NOT count as missed
  assert.equal(m.attendance_pct, 100);
});

test("cap boundary is inclusive; default cap (today) ignores far-future shifts", () => {
  const onCap = computeMetricsFromEntries(
    [entry("2026-06-15", "scheduled", "09:00:00")],
    { scheduledScoredThrough: "2026-06-15" }
  );
  assert.equal(onCap.missed_count, 1); // exactly at the cap is still scored

  // No opts → cap defaults to today (UTC); a 2099 schedule is never scored.
  const future = computeMetricsFromEntries([
    entry("2099-01-01", "scheduled", "09:00:00"),
  ]);
  assert.equal(future.scheduled_count, 0);
  assert.equal(future.attendance_pct, null);
});

test("covered shifts: worked-without-schedule counts, even past the cap", () => {
  const m = computeMetricsFromEntries(
    [
      entry("2026-06-01", "scheduled", "09:00:00"),
      entry("2026-06-01", "worked", "09:00:00"), // scheduled → not covered
      entry("2026-06-05", "worked", "12:00:00"), // unscheduled → covered
      entry("2026-06-25", "worked", "12:00:00"), // past cap, still covered
    ],
    { scheduledScoredThrough: "2026-06-15" }
  );
  assert.equal(m.covered_shifts, 2);
  assert.equal(m.attended_count, 1);
});

test("no entries: percentages null, counts zero", () => {
  const m = computeMetricsFromEntries([], CAP);
  assert.equal(m.attendance_pct, null);
  assert.equal(m.on_time_pct, null);
  assert.equal(m.on_time_grace_pct, null);
  assert.equal(m.scheduled_count, 0);
  assert.equal(m.attended_count, 0);
  assert.equal(m.missed_count, 0);
  assert.equal(m.covered_shifts, 0);
});

test("scheduled but never worked: attendance 0%, punctuality null", () => {
  const m = computeMetricsFromEntries(
    [
      entry("2026-06-01", "scheduled", "09:00:00"),
      entry("2026-06-02", "scheduled", "09:00:00"),
    ],
    CAP
  );
  assert.equal(m.attendance_pct, 0);
  assert.equal(m.missed_count, 2);
  // No attended shifts → punctuality rates are null, not 0.
  assert.equal(m.on_time_pct, null);
  assert.equal(m.on_time_grace_pct, null);
});

test("punches_time_clock=false EXCLUDES from the attendance denominator — null, never 0 (mig 056)", () => {
  // The Nick Goins shape: a salaried non-puncher with a real schedule and
  // zero worked entries. Scored normally he reads 0% forever; excluded he
  // reads not-computable. Title/pay-type must never drive this — six of
  // seven GMs punch normally — only the SA-set marker does.
  const entries = [
    entry("2026-07-01", "scheduled", "09:00:00"),
    entry("2026-07-02", "scheduled", "09:00:00"),
    entry("2026-07-03", "scheduled", "09:00:00"),
  ];
  const scored = computeMetricsFromEntries(entries, {
    scheduledScoredThrough: "2026-07-31",
  });
  assert.equal(scored.attendance_pct, 0);

  const excluded = computeMetricsFromEntries(entries, {
    scheduledScoredThrough: "2026-07-31",
    punchesTimeClock: false,
  });
  assert.equal(excluded.attendance_pct, null);
  assert.equal(excluded.on_time_pct, null);
  assert.equal(excluded.on_time_grace_pct, null);
  assert.equal(excluded.scheduled_count, 0);
  assert.equal(excluded.missed_count, 0);
});

test("punches_time_clock undefined/true scores normally — exclusion is opt-in only", () => {
  const entries = [
    entry("2026-07-01", "scheduled", "09:00:00"),
    entry("2026-07-01", "worked", "09:01:00"),
  ];
  const t = computeMetricsFromEntries(entries, {
    scheduledScoredThrough: "2026-07-31",
    punchesTimeClock: true,
  });
  assert.equal(t.attendance_pct, 100);
});

test("effective date (§2a): a non-puncher's pre-effective-date periods are untouched", () => {
  // The measured Nick Goins shape: ~80% attendance for three quarters, then
  // a collapse at COS's Toast go-live (2026-07-07). The marker must null
  // Q3 2026 onward while Q4 2025 / Q1 2026 / Q2 2026 — one a THQ frozen
  // quarter — keep their real values.
  const SINCE = "2026-07-07";
  // Q2 2026 ends before the effective date → treated as a puncher.
  assert.equal(punchesTimeClockForPeriod(false, SINCE, "2026-06-30"), true);
  // Q3 2026 overlaps it → excluded.
  assert.equal(punchesTimeClockForPeriod(false, SINCE, "2026-09-30"), false);
  // Q4 2025 (frozen) is far before it → untouched.
  assert.equal(punchesTimeClockForPeriod(false, SINCE, "2025-12-31"), true);
  // A period ending the day before the effective date is still pre-era…
  assert.equal(punchesTimeClockForPeriod(false, SINCE, "2026-07-06"), true);
  // …and one ending ON it overlaps.
  assert.equal(punchesTimeClockForPeriod(false, SINCE, "2026-07-07"), false);
});

test("effective date (§2a): null since = always excluded; marker true ignores since", () => {
  // A historic non-puncher (no punching era on record) stays excluded for
  // every period — the pre-effective-date behaviour of the bare boolean.
  assert.equal(punchesTimeClockForPeriod(false, null, "2025-12-31"), false);
  assert.equal(punchesTimeClockForPeriod(false, null, "2026-09-30"), false);
  // A puncher is never excluded, whatever a stale since says.
  assert.equal(punchesTimeClockForPeriod(true, "2026-07-07", "2026-09-30"), true);
});

test("effective date (§2a): end-to-end — pre-since quarter scores real attendance, post-since quarter reads null", () => {
  const q2Entries = [
    entry("2026-06-01", "scheduled", "09:00:00"),
    entry("2026-06-01", "worked", "08:58:00"),
    entry("2026-06-02", "scheduled", "09:00:00"),
  ];
  const q2 = computeMetricsFromEntries(q2Entries, {
    scheduledScoredThrough: "2026-06-30",
    punchesTimeClock: punchesTimeClockForPeriod(false, "2026-07-07", "2026-06-30"),
  });
  assertClose(q2.attendance_pct, 50, "pre-since attendance");

  const q3Entries = [
    entry("2026-07-10", "scheduled", "09:00:00"),
    entry("2026-07-11", "scheduled", "09:00:00"),
  ];
  const q3 = computeMetricsFromEntries(q3Entries, {
    scheduledScoredThrough: "2026-09-30",
    punchesTimeClock: punchesTimeClockForPeriod(false, "2026-07-07", "2026-09-30"),
  });
  assert.equal(q3.attendance_pct, null);
  assert.equal(q3.scheduled_count, 0);
});

test("COVER-RATIO GUARD (Q2-blocker 2026-08-25): covers dominating a near-empty denominator → null, flagged, never 0", () => {
  // The Kevin Montie shape: 5 scheduled (none worked), 16 covers. Nobody
  // works sixteen unscheduled shifts and zero scheduled ones — the
  // schedule record is the untrustworthy side.
  const entries: ReturnType<typeof entry>[] = [];
  for (let d = 1; d <= 5; d++) {
    entries.push(entry(`2026-05-0${d}`, "scheduled", "09:00:00"));
  }
  for (let d = 10; d <= 25; d++) {
    entries.push(entry(`2026-06-${d}`, "worked", "09:00:00"));
  }
  const m = computeMetricsFromEntries(entries, {
    scheduledScoredThrough: "2026-06-30",
    punchesTimeClock: true,
  });
  assert.equal(m.cover_dominated, true);
  assert.equal(m.attendance_pct, null, "cover-dominated must be not-computable, never 0%");
  assert.equal(m.on_time_pct, null);
  assert.equal(m.covered_shifts, 16, "the counts stay real");
  assert.equal(m.scheduled_count, 5);
});

test("cover-ratio guard does NOT fire on normal shapes — real absence still scores", () => {
  // 5 scheduled, 0 worked, 0 covers = genuine absence: 0% stands.
  const absent = computeMetricsFromEntries(
    [1, 2, 3, 4, 5].map((d) => entry(`2026-06-0${d}`, "scheduled", "09:00:00")),
    { scheduledScoredThrough: "2026-06-30", punchesTimeClock: true }
  );
  assert.equal(absent.cover_dominated, false);
  assert.equal(absent.attendance_pct, 0);

  // 20 scheduled+worked, 3 covers = normal profile: untouched.
  const normal: ReturnType<typeof entry>[] = [];
  for (let d = 1; d <= 20; d++) {
    const dd = String(d).padStart(2, "0");
    normal.push(entry(`2026-06-${dd}`, "scheduled", "09:00:00"));
    normal.push(entry(`2026-06-${dd}`, "worked", "08:59:00"));
  }
  for (let d = 21; d <= 23; d++) {
    normal.push(entry(`2026-06-${d}`, "worked", "09:00:00"));
  }
  const n = computeMetricsFromEntries(normal, {
    scheduledScoredThrough: "2026-06-30",
    punchesTimeClock: true,
  });
  assert.equal(n.cover_dominated, false);
  assert.equal(n.attendance_pct, 100);

  // A part-timer's small cover count (3 sched, 4 covers) stays under the
  // ≥5 floor — no false trip.
  const partTimer: ReturnType<typeof entry>[] = [
    entry("2026-06-01", "scheduled", "09:00:00"),
    entry("2026-06-01", "worked", "09:00:00"),
    entry("2026-06-02", "scheduled", "09:00:00"),
    entry("2026-06-03", "scheduled", "09:00:00"),
    entry("2026-06-10", "worked", "09:00:00"),
    entry("2026-06-11", "worked", "09:00:00"),
    entry("2026-06-12", "worked", "09:00:00"),
    entry("2026-06-13", "worked", "09:00:00"),
  ];
  const p = computeMetricsFromEntries(partTimer, {
    scheduledScoredThrough: "2026-06-30",
    punchesTimeClock: true,
  });
  assert.equal(p.cover_dominated, false);
});
