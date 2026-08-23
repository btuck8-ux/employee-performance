import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBusinessDate,
  chunkWindows,
  classifyPunches,
  planEmailSeeds,
  scoreBehaviouralMatch,
  BEHAVIOURAL_MIN_OVERLAP_DAYS,
  BEHAVIOURAL_RUNNER_UP_MARGIN,
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

// ── scoreBehaviouralMatch (ruling §4 guards, thresholds stated) ──────────

const days = (...d: string[]) => new Set(d);
const week1 = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"];

test("the stated thresholds are 6 overlap days and a 3-day runner-up margin", () => {
  // The PR body states these numbers; this pin stops silent drift.
  assert.equal(BEHAVIOURAL_MIN_OVERLAP_DAYS, 6);
  assert.equal(BEHAVIOURAL_RUNNER_UP_MARGIN, 3);
});

test("unambiguous match auto-commits", () => {
  const v = scoreBehaviouralMatch(days(...week1), [
    { employee_id: "e1", scheduledDates: days(...week1) },
    { employee_id: "e2", scheduledDates: days("2026-08-01", "2026-08-02") },
  ]);
  assert.equal(v.decision, "auto");
  assert.equal(v.best?.employee_id, "e1");
});

test("a runner-up inside the margin makes it ambiguous — identical schedules never auto-commit", () => {
  const v = scoreBehaviouralMatch(days(...week1), [
    { employee_id: "e1", scheduledDates: days(...week1) },
    { employee_id: "e2", scheduledDates: days(...week1) },
  ]);
  assert.equal(v.decision, "ambiguous");
});

test("below the minimum overlap nothing commits, however clear the lead", () => {
  const v = scoreBehaviouralMatch(days("2026-08-01", "2026-08-02"), [
    { employee_id: "e1", scheduledDates: days("2026-08-01", "2026-08-02") },
  ]);
  assert.equal(v.decision, "insufficient");
});

test("no overlapping candidate at all is insufficient", () => {
  const v = scoreBehaviouralMatch(days(...week1), [
    { employee_id: "e1", scheduledDates: days("2026-01-01") },
  ]);
  assert.equal(v.decision, "insufficient");
  assert.equal(v.best, null);
});
