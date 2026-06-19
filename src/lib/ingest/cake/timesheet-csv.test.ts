/**
 * Unit tests for the CAKE timesheet CSV parser/collapse.
 *
 *   node --test src/lib/ingest/cake/timesheet-csv.test.ts
 *   npm test
 *
 * Exercises the four behaviours the harvester guarantees: join on
 * cake_profile_id (NOT name), one-row-per-(employee,date) collapse, open-shift
 * skipping, window filtering, and unmapped-profile surfacing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClock, parseCakeTimesheetCsv, type CakeProfile } from "./timesheet-csv.ts";

function xw(entries: Array<[number, string]>): Map<number, CakeProfile> {
  const m = new Map<number, CakeProfile>();
  for (const [pid, code] of entries) {
    m.set(pid, { employee_id: `emp-${code}`, location_id: "loc-nola", employee_code: code, full_name: code });
  }
  return m;
}

test("parseClock handles 12h, 24h, and junk", () => {
  assert.equal(parseClock("9:23 AM"), "09:23:00");
  assert.equal(parseClock("12:00 AM"), "00:00:00");
  assert.equal(parseClock("12:00 PM"), "12:00:00");
  assert.equal(parseClock("16:00:21"), "16:00:21");
  assert.equal(parseClock("-"), null);
  assert.equal(parseClock(""), null);
  assert.equal(parseClock("nonsense"), null);
});

const HEADER = "cake_profile_id,first_name,last_name,business_date,clock_in,clock_out,paid_hours,hourly_rate,job_title";

test("collapses split shifts to earliest-in/latest-out with summed hours", () => {
  const csv = [
    HEADER,
    // two shifts same person/day -> collapse
    "100,Joani,Barron,2026-06-13,10:55:00,18:43:19,7.8,5,Cook",
    "100,Joani,Barron,2026-06-13,19:33:04,21:22:24,1.82,5,Cook",
  ].join("\n");
  const r = parseCakeTimesheetCsv(csv, xw([[100, "EMP-1"]]));
  assert.equal(r.records.length, 1);
  const row = r.records[0];
  assert.equal(row.entry_date, "2026-06-13");
  assert.equal(row.in_time, "10:55:00");
  assert.equal(row.out_time, "21:22:24");
  assert.equal(row.regular_hours, 9.62);
  assert.equal(row.employee_id, "emp-EMP-1");
});

test("skips open shifts (no clock_out) and reports unmapped profile ids", () => {
  const csv = [
    HEADER,
    "100,Joani,Barron,2026-06-14,09:00:00,17:00:00,8,5,Cook",
    "100,Joani,Barron,2026-06-19,09:23:00,,0,5,Cook", // open shift -> skipped
    "999,Ghost,User,2026-06-14,09:00:00,17:00:00,8,5,Cook", // not in crosswalk
  ].join("\n");
  const r = parseCakeTimesheetCsv(csv, xw([[100, "EMP-1"]]));
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].entry_date, "2026-06-14");
  assert.deepEqual(r.unmapped_profile_ids, [999]);
});

test("filters to the inclusive [windowStart, windowEnd] business-date window", () => {
  const csv = [
    HEADER,
    "100,Joani,Barron,2026-06-08,09:00:00,17:00:00,8,5,Cook", // before window
    "100,Joani,Barron,2026-06-09,09:00:00,17:00:00,8,5,Cook",
    "100,Joani,Barron,2026-06-18,09:00:00,17:00:00,8,5,Cook",
    "100,Joani,Barron,2026-06-19,09:00:00,17:00:00,8,5,Cook", // after window
  ].join("\n");
  const r = parseCakeTimesheetCsv(csv, xw([[100, "EMP-1"]]), {
    windowStart: "2026-06-09",
    windowEnd: "2026-06-18",
  });
  const dates = r.records.map((x) => x.entry_date).sort();
  assert.deepEqual(dates, ["2026-06-09", "2026-06-18"]);
});

test("joins on profile id even when the CSV name disagrees with the roster", () => {
  // CAKE stores 'Tolson'; roster/crosswalk knows EMP-9. Join is by id, so it maps.
  const csv = [HEADER, "200,Nicholas,Tolson,2026-06-17,17:18:02,22:58:31,5.67,10,Bartender"].join("\n");
  const r = parseCakeTimesheetCsv(csv, xw([[200, "EMP-9"]]));
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].employee_id, "emp-EMP-9");
  assert.deepEqual(r.unmapped_profile_ids, []);
});
