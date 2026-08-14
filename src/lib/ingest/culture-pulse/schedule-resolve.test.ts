/**
 * Tests for the CP schedule feed's pure resolve + collapse layer.
 *
 * Pins the contract the scoring math depends on (performance-recompute.ts
 * reads entry_date / entry_type / in_time with the 3-minute grace):
 *   - the feed only ever emits entry_type='scheduled';
 *   - one row per (employee, LOCAL date of shift start);
 *   - CSV-era merge semantics: earliest-in / latest-out / summed hours;
 *   - resolution precedence: employee_code, then sevenshifts_user_id,
 *     then skip (never mint identities).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildScheduleRosterIndex,
  collapseCpSchedule,
  buildScheduledEntryPayload,
  type CpScheduleRow,
  type ScheduleRosterEmployee,
} from "./schedule-resolve.ts";

const DENVER = "America/Denver";
const CHICAGO = "America/Chicago";

const ROSTER: ScheduleRosterEmployee[] = [
  { id: "emp-ana", employee_name: "Ana Alvarez", employee_code: "100001", seven_shifts_user_id: 111, active: true },
  { id: "emp-bo", employee_name: "Bo Byrd", employee_code: "100002", seven_shifts_user_id: null, active: true },
  { id: "emp-cy", employee_name: "Cy Chen", employee_code: null, seven_shifts_user_id: 333, active: true },
  { id: "emp-dee", employee_name: "Dee Dunn", employee_code: "100004", seven_shifts_user_id: 444, active: false },
];

function row(overrides: Partial<CpScheduleRow>): CpScheduleRow {
  return {
    id: "cp-row",
    employee_name: null,
    employee_email: null,
    shift_start_at: null,
    shift_end_at: null,
    role: null,
    employee_code: null,
    sevenshifts_user_id: null,
    ...overrides,
  };
}

describe("collapseCpSchedule — resolution", () => {
  it("resolves by employee_code first, tolerating whitespace/case", () => {
    const index = buildScheduleRosterIndex(ROSTER);
    const out = collapseCpSchedule(
      [
        row({
          id: "r1",
          employee_code: "  100001 ",
          // Wrong sevenshifts id on the row must NOT win over the code.
          sevenshifts_user_id: 333,
          shift_start_at: "2026-06-15T15:00:00Z",
          shift_end_at: "2026-06-15T21:00:00Z",
        }),
      ],
      index,
      DENVER
    );
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0].employee_id, "emp-ana");
    assert.equal(out.resolved_by_code, 1);
    assert.equal(out.resolved_by_seven_shifts_id, 0);
  });

  it("falls back to sevenshifts_user_id when the code is absent or unknown", () => {
    const index = buildScheduleRosterIndex(ROSTER);
    const out = collapseCpSchedule(
      [
        row({
          id: "r1",
          employee_code: "999999", // not an EPD code
          sevenshifts_user_id: "333", // string form must coerce
          shift_start_at: "2026-06-15T15:00:00Z",
          shift_end_at: "2026-06-15T21:00:00Z",
        }),
      ],
      index,
      DENVER
    );
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0].employee_id, "emp-cy");
    assert.equal(out.resolved_by_seven_shifts_id, 1);
  });

  it("skips unmatched rows (never mints identities) and surfaces labels", () => {
    const index = buildScheduleRosterIndex(ROSTER);
    const out = collapseCpSchedule(
      [
        row({
          id: "r1",
          employee_name: "New Hire",
          employee_code: null,
          sevenshifts_user_id: 999,
          shift_start_at: "2026-06-15T15:00:00Z",
        }),
      ],
      index,
      DENVER
    );
    assert.equal(out.entries.length, 0);
    assert.deepEqual(out.unmatched, ["New Hire"]);
  });

  it("counts skipped ROWS separately from the deduped labels", () => {
    const index = buildScheduleRosterIndex(ROSTER);
    const out = collapseCpSchedule(
      [
        row({ id: "r1", employee_name: "New Hire", shift_start_at: "2026-06-15T15:00:00Z" }),
        row({ id: "r2", employee_name: "New Hire", shift_start_at: "2026-06-16T15:00:00Z" }),
      ],
      index,
      DENVER
    );
    // One label, two skipped rows — rows_skipped accounting uses the counts
    // (Codex finding 4, 2026-08-14).
    assert.deepEqual(out.unmatched, ["New Hire"]);
    assert.equal(out.unmatched_rows, 2);
  });

  it("skips inactive employees with a count, like the CSV importer", () => {
    const index = buildScheduleRosterIndex(ROSTER);
    const out = collapseCpSchedule(
      [
        row({
          id: "r1",
          employee_name: "Dee Dunn",
          employee_code: "100004",
          shift_start_at: "2026-06-15T15:00:00Z",
        }),
      ],
      index,
      DENVER
    );
    assert.equal(out.entries.length, 0);
    assert.deepEqual(out.inactive_skipped, ["Dee Dunn"]);
  });

  it("counts rows with no parseable start as skipped_no_start", () => {
    const index = buildScheduleRosterIndex(ROSTER);
    const out = collapseCpSchedule(
      [row({ id: "r1", employee_code: "100001", shift_start_at: null })],
      index,
      DENVER
    );
    assert.equal(out.entries.length, 0);
    assert.equal(out.skipped_no_start, 1);
  });
});

describe("collapseCpSchedule — timezone projection", () => {
  it("projects UTC starts to store-local wall clock (Denver, MDT)", () => {
    const index = buildScheduleRosterIndex(ROSTER);
    const out = collapseCpSchedule(
      [
        row({
          id: "r1",
          employee_code: "100001",
          shift_start_at: "2026-06-15T15:00:00Z", // 09:00 MDT
          shift_end_at: "2026-06-15T21:30:00Z", // 15:30 MDT
        }),
      ],
      index,
      DENVER
    );
    const e = out.entries[0];
    assert.equal(e.entry_date, "2026-06-15");
    assert.equal(e.in_time, "09:00:00");
    assert.equal(e.out_time, "15:30:00");
    assert.equal(e.hours, 6.5);
  });

  it("uses the LOCAL date of the shift start when UTC has rolled over", () => {
    const index = buildScheduleRosterIndex(ROSTER);
    const out = collapseCpSchedule(
      [
        row({
          id: "r1",
          employee_code: "100001",
          // 2026-07-04T04:30Z = 2026-07-03 22:30 MDT — local date is Jul 3.
          shift_start_at: "2026-07-04T04:30:00Z",
          shift_end_at: "2026-07-04T08:00:00Z",
        }),
      ],
      index,
      DENVER
    );
    const e = out.entries[0];
    assert.equal(e.entry_date, "2026-07-03");
    assert.equal(e.in_time, "22:30:00");
  });

  it("keeps an overnight shift on its start date with the duration intact", () => {
    const index = buildScheduleRosterIndex(ROSTER);
    const out = collapseCpSchedule(
      [
        row({
          id: "r1",
          employee_code: "100001",
          shift_start_at: "2026-06-16T04:00:00Z", // Jun 15 22:00 Chicago
          shift_end_at: "2026-06-16T08:00:00Z", // Jun 16 03:00 Chicago
        }),
      ],
      index,
      CHICAGO
    );
    const e = out.entries[0];
    assert.equal(e.entry_date, "2026-06-15");
    assert.equal(e.in_time, "23:00:00");
    // Same as a CSV overnight row: out_time reads "earlier" than in_time.
    assert.equal(e.out_time, "03:00:00");
    assert.equal(e.hours, 4);
  });
});

describe("collapseCpSchedule — multi-shift merge (CSV-era rule)", () => {
  it("collapses split shifts to earliest-in / latest-out with hours summed", () => {
    const index = buildScheduleRosterIndex(ROSTER);
    const out = collapseCpSchedule(
      [
        row({
          id: "r1",
          employee_code: "100001",
          shift_start_at: "2026-06-15T23:00:00Z", // 17:00 MDT
          shift_end_at: "2026-06-16T03:00:00Z", // 21:00 MDT, 4h
          role: "Closer",
        }),
        row({
          id: "r2",
          employee_code: "100001",
          shift_start_at: "2026-06-15T15:00:00Z", // 09:00 MDT
          shift_end_at: "2026-06-15T19:00:00Z", // 13:00 MDT, 4h
          role: "Opener",
        }),
      ],
      index,
      DENVER
    );
    assert.equal(out.entries.length, 1);
    const e = out.entries[0];
    assert.equal(e.entry_date, "2026-06-15");
    assert.equal(e.in_time, "09:00:00");
    assert.equal(e.out_time, "21:00:00");
    assert.equal(e.hours, 8);
    // Role follows the earliest-starting shift.
    assert.equal(e.role, "Opener");
    assert.equal(e.shift_count, 2);
    assert.equal(out.multi_shift_days, 1);
  });

  it("keeps different local dates as separate entries", () => {
    const index = buildScheduleRosterIndex(ROSTER);
    const out = collapseCpSchedule(
      [
        row({
          id: "r1",
          employee_code: "100001",
          shift_start_at: "2026-06-15T15:00:00Z",
          shift_end_at: "2026-06-15T21:00:00Z",
        }),
        row({
          id: "r2",
          employee_code: "100001",
          shift_start_at: "2026-06-16T15:00:00Z",
          shift_end_at: "2026-06-16T21:00:00Z",
        }),
      ],
      index,
      DENVER
    );
    assert.equal(out.entries.length, 2);
    assert.equal(out.multi_shift_days, 0);
  });
});

describe("buildScheduledEntryPayload — shape contract", () => {
  it("only ever emits entry_type='scheduled' with wage null and pay zeros", () => {
    const payload = buildScheduledEntryPayload(
      {
        employee_id: "emp-ana",
        entry_date: "2026-06-15",
        in_time: "09:00:00",
        out_time: "15:30:00",
        hours: 6.5,
        role: "Opener",
        shift_count: 1,
      },
      "loc-1"
    );
    assert.equal(payload.entry_type, "scheduled");
    assert.equal(payload.wage, null);
    assert.equal(payload.regular_hours, 6.5);
    assert.equal(payload.ot_hours, 0);
    assert.equal(payload.double_ot_hours, 0);
    assert.equal(payload.holiday_hours, 0);
    assert.equal(payload.regular_pay, 0);
    assert.equal(payload.ot_pay, 0);
    assert.equal(payload.double_ot_pay, 0);
    assert.equal(payload.holiday_pay, 0);
    assert.equal(payload.total_pay, 0);
    // The exact column set the CSV-era scheduled path wrote — nothing extra.
    assert.deepEqual(Object.keys(payload).sort(), [
      "double_ot_hours",
      "double_ot_pay",
      "employee_id",
      "entry_date",
      "entry_type",
      "holiday_hours",
      "holiday_pay",
      "in_time",
      "location_id",
      "ot_hours",
      "ot_pay",
      "out_time",
      "regular_hours",
      "regular_pay",
      "role",
      "total_pay",
      "wage",
    ]);
  });
});
