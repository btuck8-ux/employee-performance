import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBusinessDate,
  chunkWindows,
  classifyPunches,
  planEmailSeeds,
  scoreTimeAwareMatch,
  medianAbsDeltaMinutes,
  blockedEmployeeIds,
  BEHAVIOURAL_MIN_OVERLAP_DAYS,
  TIME_CEILING_MIN,
  TIME_RUNNER_UP_MARGIN_MIN,
  type RawToastTimeEntry,
} from "./labor-core.ts";

// ── normalizeBusinessDate ────────────────────────────────────────────────

test("businessDate yyyyMMdd (number and string) normalizes", () => {
  assert.equal(normalizeBusinessDate({ businessDate: 20260701 }), "2026-07-01");
  assert.equal(normalizeBusinessDate({ businessDate: "20260820" }), "2026-08-20");
});

test("businessDate ISO passes through; inDate is the fallback; junk is null", () => {
  assert.equal(normalizeBusinessDate({ businessDate: "2026-07-01T00:00:00Z" }), "2026-07-01");
  assert.equal(
    normalizeBusinessDate({ inDate: "2026-07-02T14:03:00.000+0000" }),
    "2026-07-02"
  );
  assert.equal(normalizeBusinessDate({ businessDate: "wat" }), null);
  assert.equal(normalizeBusinessDate({}), null);
});

// ── chunkWindows (Toast's 30-day cap → ≤28-day chunks) ───────────────────

test("a 51-day window chunks into 2 requests, inclusive and gap-free", () => {
  const chunks = chunkWindows("2026-07-01", "2026-08-20");
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].startIso, "2026-07-01T00:00:00.000Z");
  assert.equal(chunks[0].endIso, "2026-07-28T23:59:59.999Z");
  assert.equal(chunks[1].startIso, "2026-07-29T00:00:00.000Z");
  assert.equal(chunks[1].endIso, "2026-08-20T23:59:59.999Z");
});

test("a one-day window is one chunk; an inverted window is none", () => {
  assert.equal(chunkWindows("2026-08-20", "2026-08-20").length, 1);
  assert.equal(chunkWindows("2026-08-21", "2026-08-20").length, 0);
});

// ── classifyPunches ──────────────────────────────────────────────────────

function entry(overrides: Partial<RawToastTimeEntry>): RawToastTimeEntry {
  return {
    guid: "te-1",
    businessDate: 20260801,
    inDate: "2026-08-01T15:00:00.000+0000",
    outDate: "2026-08-01T22:00:00.000+0000",
    regularHours: 7,
    overtimeHours: 0,
    deleted: false,
    employeeReference: { guid: "toast-emp-A" },
    jobReference: { guid: "job-1" },
    ...overrides,
  };
}

test("a crosswalked punch is attributed; an unmatched one is stored null and queued", () => {
  const xwalk = new Map([["toast-emp-A", "epd-1"]]);
  const { rows, unmatchedPunchDates } = classifyPunches(
    [
      entry({ guid: "te-1" }),
      entry({ guid: "te-2", employeeReference: { guid: "toast-emp-B" } }),
    ],
    "loc-1",
    xwalk,
    "2026-08-23T00:00:00Z"
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].employee_id, "epd-1");
  assert.equal(rows[1].employee_id, null);
  assert.deepEqual([...(unmatchedPunchDates.get("toast-emp-B") ?? [])], ["2026-08-01"]);
  assert.equal(unmatchedPunchDates.has("toast-emp-A"), false);
});

test("Toast's 1970 deletedDate placeholder reads as not-deleted", () => {
  const { rows } = classifyPunches(
    [entry({ deletedDate: "1970-01-01T00:00:00.000+0000" })],
    "loc-1",
    new Map(),
    "now"
  );
  assert.equal(rows[0].deleted_at, null);
});

test("entries without a guid, date, or clock-in are counted, not stored", () => {
  const { rows, skippedNoGuid, skippedNoDate, skippedNoIn } = classifyPunches(
    [
      entry({ guid: null as unknown as string }),
      entry({ guid: "te-3", businessDate: undefined, inDate: undefined }),
      entry({ guid: "te-4", inDate: undefined, businessDate: 20260801 }),
    ],
    "loc-1",
    new Map(),
    "now"
  );
  assert.equal(rows.length, 0);
  assert.equal(skippedNoGuid, 1);
  assert.equal(skippedNoDate, 1);
  assert.equal(skippedNoIn, 1);
});

// ── planEmailSeeds ───────────────────────────────────────────────────────

test("email seeds only on exactly-one EPD match, case-insensitive", () => {
  const plan = planEmailSeeds(
    [
      { guid: "g1", email: "A@x.com" },
      { guid: "g2", email: "shared@x.com" },
      { guid: "g3", email: "nobody@x.com" },
      { guid: "g4", email: null },
    ],
    [
      { id: "e1", email: "a@x.com" },
      { id: "e2", email: "shared@x.com" },
      { id: "e3", email: "shared@x.com" },
    ],
    new Set()
  );
  assert.deepEqual(plan.seeds, [{ toast_employee_guid: "g1", employee_id: "e1" }]);
  assert.equal(plan.ambiguousEmails, 1);
});

test("an already-mapped guid never re-seeds", () => {
  const plan = planEmailSeeds(
    [{ guid: "g1", email: "a@x.com" }],
    [{ id: "e1", email: "a@x.com" }],
    new Set(["g1"])
  );
  assert.equal(plan.seeds.length, 0);
});

// ── time-aware scorer (defect 2026-08-24 §5b, thresholds stated) ─────────

const WEEK = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"];

/** date -> timestamp at `hour`:`min` UTC on that date. */
function times(dates: string[], hour: number, min = 0): Map<string, string> {
  return new Map(
    dates.map((d) => [
      d,
      `${d}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00.000Z`,
    ])
  );
}

test("the stated thresholds: 6 overlap days, 60-minute ceiling, 15-minute time margin", () => {
  // The PR body states these numbers; this pin stops silent drift. The 60
  // was set from the measured distribution (correct rows ≤ 45.3 min; wrong
  // attributions 124 and 302 min).
  assert.equal(BEHAVIOURAL_MIN_OVERLAP_DAYS, 6);
  assert.equal(TIME_CEILING_MIN, 60);
  assert.equal(TIME_RUNNER_UP_MARGIN_MIN, 15);
});

test("medianAbsDeltaMinutes pairs by date and is timezone-free", () => {
  const { paired_days, median_min } = medianAbsDeltaMinutes(
    times(WEEK, 15, 10), // clock-ins 15:10Z
    times(WEEK, 15, 0) // scheduled 15:00Z
  );
  assert.equal(paired_days, 6);
  assert.equal(median_min, 10);
  assert.equal(medianAbsDeltaMinutes(new Map(), times(WEEK, 15)).median_min, null);
});

test("median averages the middle pair on even counts and drops unparseable timestamps", () => {
  const four = WEEK.slice(0, 4);
  // Deltas 2, 4, 6, 8 → median (4+6)/2 = 5.
  const punches = new Map(
    four.map((d, i) => [d, `${d}T15:${String((i + 1) * 2).padStart(2, "0")}:00.000Z`])
  );
  const even = medianAbsDeltaMinutes(punches, times(four, 15));
  assert.equal(even.paired_days, 4);
  assert.equal(even.median_min, 5);
  const junk = new Map([["2026-08-01", "not-a-timestamp"]]);
  assert.equal(medianAbsDeltaMinutes(junk, times(["2026-08-01"], 15)).median_min, null);
});

test("an exact margin-sized gap is still ambiguous (inclusive boundary)", () => {
  const v = scoreTimeAwareMatch(times(WEEK, 15, 0), [
    { employee_id: "e1", scheduleStartByDate: times(WEEK, 15, 0) }, // 0 min
    { employee_id: "e2", scheduleStartByDate: times(WEEK, 15, 15) }, // exactly 15 min
  ]);
  assert.equal(v.decision, "ambiguous");
});

test("a punctual, unopposed match auto-commits with time evidence", () => {
  const v = scoreTimeAwareMatch(times(WEEK, 15, 5), [
    { employee_id: "e1", scheduleStartByDate: times(WEEK, 15) },
    { employee_id: "e2", scheduleStartByDate: times(["2026-08-01"], 15) },
  ]);
  assert.equal(v.decision, "auto");
  assert.equal(v.best?.employee_id, "e1");
  assert.equal(v.best?.median_clockin_delta_min, 5);
  assert.equal(v.candidate_pool_size, 2);
  assert.equal(v.eligible_count, 1);
});

test("the time ceiling is REQUIRED: a 124-minute median never auto-commits, whatever the overlap", () => {
  // The CPD mis-attribution shape: big unopposed day-overlap, wrong person.
  const v = scoreTimeAwareMatch(times(WEEK, 17, 4), [
    { employee_id: "wrong", scheduleStartByDate: times(WEEK, 15) },
  ]);
  assert.equal(v.decision, "insufficient");
  assert.equal(v.eligible_count, 0);
});

test("time wins over day-overlap when the two disagree", () => {
  // A has more overlapping days but clocks in ~40 min off; B has fewer
  // days at a 2-minute median. B is the person.
  const wide = [...WEEK, "2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10"];
  const punches = new Map([...times(wide, 15, 2)]);
  const v = scoreTimeAwareMatch(punches, [
    { employee_id: "A", scheduleStartByDate: times(wide, 14, 20) },
    { employee_id: "B", scheduleStartByDate: times(WEEK, 15) },
  ]);
  assert.equal(v.decision, "auto");
  assert.equal(v.best?.employee_id, "B");
});

test("two eligible candidates within the time margin are ambiguous — identical schedules queue", () => {
  const v = scoreTimeAwareMatch(times(WEEK, 15, 5), [
    { employee_id: "e1", scheduleStartByDate: times(WEEK, 15) },
    { employee_id: "e2", scheduleStartByDate: times(WEEK, 15, 10) },
  ]);
  assert.equal(v.decision, "ambiguous");
});

test("below the day floor nothing commits, however punctual", () => {
  const v = scoreTimeAwareMatch(times(["2026-08-01", "2026-08-02"], 15, 1), [
    { employee_id: "e1", scheduleStartByDate: times(["2026-08-01", "2026-08-02"], 15) },
  ]);
  assert.equal(v.decision, "insufficient");
});

// ── §5a eligibility: zero-punch mappings must not block their owner ──────

test("a zero-punch mapping leaves its employee eligible; a punched one blocks", () => {
  const blocked = blockedEmployeeIds([
    { employee_id: "jesus", punch_count: 0 }, // stale email-matched account
    { employee_id: "liv", punch_count: 42 },
  ]);
  assert.equal(blocked.has("jesus"), false);
  assert.equal(blocked.has("liv"), true);
});

test("MUTUAL EXCLUSION (§5b, 2026-08-25): a candidate punched in on their OWN account cannot be the disputed GUID", () => {
  // The 6c62e9c8 fixture: three candidates inside the ambiguity margin —
  // clock-in proximity collapses where every scheduled start is 15:00
  // (variance is the discriminator's fuel). Both rivals were already
  // punched in on their own GUIDs on the disputed days (one 26 seconds
  // apart); the sole candidate with no competing punch is the answer.
  const disputed = times(WEEK, 15, 2);
  const identical = times(WEEK, 15, 0);
  const v = scoreTimeAwareMatch(disputed, [
    // Keara Beck shape: own-account punch on a disputed day.
    { employee_id: "beck", scheduleStartByDate: identical, ownPunchDays: new Set([WEEK[0]]) },
    // Oliver Pearson shape: own-account punch on another disputed day.
    { employee_id: "pearson", scheduleStartByDate: identical, ownPunchDays: new Set([WEEK[1]]) },
    // Michael Lee shape: no competing punch anywhere.
    { employee_id: "lee", scheduleStartByDate: identical },
  ]);
  assert.equal(v.mutually_excluded_count, 2);
  assert.equal(v.decision, "auto");
  assert.equal(v.best?.employee_id, "lee");
});

test("mutual exclusion only fires on OVERLAPPING days — an own punch elsewhere is not a conflict", () => {
  const disputed = times(WEEK.slice(0, 6), 15, 1);
  const v = scoreTimeAwareMatch(disputed, [
    {
      employee_id: "e1",
      scheduleStartByDate: times(WEEK.slice(0, 6), 15, 0),
      // Own punch on a NON-disputed day: no conflict, still a candidate.
      ownPunchDays: new Set(["2026-01-01"]),
    },
  ]);
  assert.equal(v.mutually_excluded_count, 0);
  assert.equal(v.decision, "auto");
  assert.equal(v.best?.employee_id, "e1");
});
