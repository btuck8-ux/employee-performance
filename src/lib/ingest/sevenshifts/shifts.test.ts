/**
 * §4-H7 tests for the direct 7shifts scheduled-shift feed: classification,
 * reconcile arithmetic, and the text-level collision/token pins.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyShifts, missingIds, type RawShift } from "./shifts-core.ts";
import {
  reconcileScheduleSets,
  type CpSourcedDay,
  type DirectShiftRow,
} from "./reconcile.ts";
import type { LocationCrosswalk } from "./crosswalk";

const COS: LocationCrosswalk = {
  id: "epd-cos",
  name: "Colorado Springs",
  location_code: "COS",
  timezone: "America/Denver",
  company_id: 185592,
  seven_shifts_location_id: 488681,
  pos_via_7shifts: false,
  actuals_source: "7shifts",
};
const CPD: LocationCrosswalk = { ...COS, id: "epd-cpd", name: "Central Park", location_code: "CPD", seven_shifts_location_id: 236190 };

const NOW = "2026-08-23T12:00:00.000Z";

function rawShift(overrides: Partial<RawShift>): RawShift {
  return {
    id: 1,
    user_id: 11787881,
    location_id: 488681,
    start: "2026-08-20T09:00:00-06:00",
    end: "2026-08-20T17:00:00-06:00",
    deleted: false,
    draft: false,
    open: false,
    publish_status: "published",
    attendance_status: "none",
    late_minutes: 0,
    ...overrides,
  };
}

const EMP_MAP = new Map([["epd-cos", new Map([[11787881, "emp-nathan"]])], ["epd-cpd", new Map<number, string>()]]);

test("an assigned shift classifies to its store with the local business date", () => {
  const c = classifyShifts([rawShift({})], [COS, CPD], EMP_MAP, NOW, null);
  const rows = c.byLocation.get("epd-cos")!;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].employee_id, "emp-nathan");
  assert.equal(rows[0].entry_date, "2026-08-20");
  assert.equal(rows[0].attendance_status, "none");
  assert.ok(c.seenIdsByLocation.get("epd-cos")!.has(1));
});

test("open / user-0 / null-assignee shifts are never stored (addendum §4)", () => {
  const c = classifyShifts(
    [
      rawShift({ id: 2, open: true }),
      rawShift({ id: 3, user_id: 0 }),
      rawShift({ id: 4, user_id: null }),
    ],
    [COS, CPD],
    EMP_MAP,
    NOW,
    null
  );
  assert.equal(c.skippedOpenOrUnassigned, 3);
  assert.equal(c.byLocation.get("epd-cos")!.length, 0);
});

test("draft and deleted shifts are filtered at read time", () => {
  const c = classifyShifts(
    [rawShift({ id: 5, draft: true }), rawShift({ id: 6, deleted: true })],
    [COS, CPD],
    EMP_MAP,
    NOW,
    null
  );
  assert.equal(c.skippedDraft, 1);
  assert.equal(c.skippedDeleted, 1);
  assert.equal(c.byLocation.get("epd-cos")!.length, 0);
});

test("non-crosswalked locations (the Chico class, 521585) are excluded", () => {
  const c = classifyShifts(
    [rawShift({ id: 7, location_id: 521585 })],
    [COS, CPD],
    EMP_MAP,
    NOW,
    null
  );
  assert.equal(c.skippedOtherLocation, 1);
});

test("a real user id with no roster row stores unmatched (employee_id null), never dropped", () => {
  const c = classifyShifts(
    [rawShift({ id: 8, user_id: 99999999 })],
    [COS, CPD],
    EMP_MAP,
    NOW,
    null
  );
  const rows = c.byLocation.get("epd-cos")!;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].employee_id, null);
  assert.deepEqual(c.unmatchedUserIds, [99999999]);
});

test("role column is omitted when the role lookup failed (upsert leaves stored value untouched)", () => {
  const noRoles = classifyShifts([rawShift({ id: 9, role_id: 5 })], [COS, CPD], EMP_MAP, NOW, null);
  assert.ok(!("role" in noRoles.byLocation.get("epd-cos")![0]));
  const withRoles = classifyShifts(
    [rawShift({ id: 10, role_id: 5 })],
    [COS, CPD],
    EMP_MAP,
    NOW,
    new Map([[5, "Cashier"]])
  );
  assert.equal(withRoles.byLocation.get("epd-cos")![0].role, "Cashier");
});

test("missingIds: absence arithmetic for the tombstone pass", () => {
  assert.deepEqual(missingIds([1, 2, 3], new Set([1, 3])), [2]);
  assert.deepEqual(missingIds([], new Set([1])), []);
  assert.deepEqual(missingIds([4, 5], new Set()), [4, 5]);
});

// ── Reconciliation fixture (§4-H5/H7) ───────────────────────────────────────

test("reconcileScheduleSets buckets vanished / cp-only / direct-only correctly", () => {
  const codeByLoc = new Map([["epd-cos", "COS"]]);
  const direct: DirectShiftRow[] = [
    // live shift matching a CP day
    { seven_shifts_shift_id: 1, location_id: "epd-cos", employee_id: "e1", entry_date: "2026-08-18", start_at: "2026-08-18T09:00:00-06:00", missing_upstream_since: null, attendance_status: "no_show" },
    // tombstoned shift on a CP-counted day -> vanished upstream
    { seven_shifts_shift_id: 2, location_id: "epd-cos", employee_id: "e2", entry_date: "2026-08-18", start_at: "2026-08-18T10:00:00-06:00", missing_upstream_since: "2026-08-22T09:00:00Z", attendance_status: null },
    // live shift CP never had -> direct-only
    { seven_shifts_shift_id: 3, location_id: "epd-cos", employee_id: "e3", entry_date: "2026-08-19", start_at: "2026-08-19T09:00:00-06:00", missing_upstream_since: null, attendance_status: "none" },
    // unmatched row is excluded from day math but counted
    { seven_shifts_shift_id: 4, location_id: "epd-cos", employee_id: null, entry_date: "2026-08-19", start_at: "2026-08-19T09:00:00-06:00", missing_upstream_since: null, attendance_status: null },
  ];
  const cp: CpSourcedDay[] = [
    { employee_id: "e1", location_id: "epd-cos", entry_date: "2026-08-18", entry_type: "scheduled", in_time: "09:05:00" },
    { employee_id: "e2", location_id: "epd-cos", entry_date: "2026-08-18", entry_type: "scheduled", in_time: "10:00:00" },
    // scheduled day with NO direct row at all -> cp-only
    { employee_id: "e4", location_id: "epd-cos", entry_date: "2026-08-17", entry_type: "scheduled", in_time: "08:00:00" },
  ];
  const r = reconcileScheduleSets(direct, cp, codeByLoc);
  assert.equal(r.totals.cp_scheduled_days, 3);
  assert.equal(r.totals.in_both, 1);
  assert.equal(r.totals.cp_day_vanished_upstream, 1);
  assert.equal(r.totals.cp_only_days, 1);
  assert.equal(r.totals.direct_only_days, 1);
  assert.equal(r.totals.direct_unmatched_rows, 1);
  assert.equal(r.totals.start_time_mismatches, 0, "9:05 vs 9:00 is inside the 15-min band");
  assert.equal(r.by_store.COS.vanished_or_cp_only, 2);
  assert.equal(r.by_store.COS.cp_scheduled_days, 3);
  // e1's day is scheduled-unworked -> its live shift's status is counted
  assert.equal(r.unworked_day_status.no_show, 1);
});

test("start-time disagreements beyond 15 minutes are counted", () => {
  const codeByLoc = new Map([["epd-cos", "COS"]]);
  const direct: DirectShiftRow[] = [
    { seven_shifts_shift_id: 1, location_id: "epd-cos", employee_id: "e1", entry_date: "2026-08-18", start_at: "2026-08-18T09:00:00-06:00", missing_upstream_since: null, attendance_status: null },
  ];
  const cp: CpSourcedDay[] = [
    { employee_id: "e1", location_id: "epd-cos", entry_date: "2026-08-18", entry_type: "scheduled", in_time: "10:00:00" },
    { employee_id: "e1", location_id: "epd-cos", entry_date: "2026-08-18", entry_type: "worked", in_time: "10:00:00" },
  ];
  const r = reconcileScheduleSets(direct, cp, codeByLoc);
  assert.equal(r.totals.start_time_mismatches, 1);
  // worked day -> nothing lands in unworked_day_status
  assert.deepEqual(r.unworked_day_status, {});
});

// ── Text-level pins (repo convention) ───────────────────────────────────────

const shiftsSrc = readFileSync(
  join(process.cwd(), "src/lib/ingest/sevenshifts/shifts.ts"),
  "utf8"
);

test("the direct feed NEVER touches time_entries (§4-H3 collision guard)", () => {
  // Four writers already upsert on time_entries' (employee, date, type) key;
  // a fifth would collide with CP's schedule ingest nightly and whichever
  // ran last would silently win. This is the pin that stops a future
  // refactor from quietly reintroducing the conflict.
  assert.doesNotMatch(shiftsSrc, /from\("time_entries"\)/);
  assert.match(shiftsSrc, /from\("seven_shifts_shifts"\)/);
});

test("the client path is the shifts endpoint, riding the shared token routing", () => {
  assert.match(shiftsSrc, /getAllWithMeta<RawShift>\(\s*companyId,\s*"shifts"/);
  // Token routing stays inside client.ts (185592 must never fall back to the
  // NOLA token — a wrong token silently returns another company's data).
  assert.doesNotMatch(shiftsSrc, /process\.env/);
  assert.doesNotMatch(shiftsSrc, /IKES_/);
});

test("absence-tombstoning is gated on a complete pull AND the nightly's own window", () => {
  assert.match(shiftsSrc, /truncated/);
  // Strengthened 2026-08-25 (Q2 punch-recovery §3f): an explicit historical
  // window never tombstones — deep-history absence may be 7shifts'
  // retention boundary, not deletion.
  assert.match(shiftsSrc, /if \(!truncated && !opts\?\.window\) \{/);
  // Tombstones stamp, never delete.
  assert.doesNotMatch(shiftsSrc, /\.delete\(\)/);
});

test("the fence comment records the 2026-08-23 ruling (§4-H1)", () => {
  const clientSrc = readFileSync(
    join(process.cwd(), "src/lib/ingest/sevenshifts/client.ts"),
    "utf8"
  );
  assert.match(clientSrc, /2026-08-23/);
  assert.match(clientSrc, /NOT scheduling-as-a-product/);
  assert.doesNotMatch(clientSrc, /ACTUALS ONLY/);
});
