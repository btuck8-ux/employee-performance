/**
 * Unit tests for the 7Tasks API mapper. Fixtures mirror the live task_lists
 * payload captured by the Step 0 probe (2026-07-27): embedded tasks with
 * user_id + completed_at, local-offset ISO timestamps, repeated task titles
 * inside one list.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapApiListsToParsedTasks,
  enumerateDates,
  type ApiTaskList,
} from "./tasks-api-source.ts";

const NAMES = new Map<number, string>([[10467447, "Jose Mena"]]);
const nameFor = (id: number) => NAMES.get(id) ?? null;

const LIST: ApiTaskList = {
  id: 71629456,
  title: "All Day Tasks",
  start: "2026-07-25T10:00:00-05:00",
  due: "2026-07-25T21:00:00-05:00",
  tasks: [
    {
      id: 1,
      title: "Wipe Down Tables",
      user_id: 10467447,
      completed_at: "2026-07-25T13:43:59-05:00",
      task_completion: { type: "CHECKMARK" },
    },
    { id: 2, title: "Wipe Down Tables 2", user_id: null, completed_at: null },
    // Same title three times — must merge to ONE ParsedTask (the upsert key
    // would otherwise collide inside a single batch).
    {
      id: 3,
      title: "Sweep Kitchen Line",
      user_id: 10467447,
      completed_at: "2026-07-25T12:25:35-05:00",
    },
    { id: 4, title: "Sweep Kitchen Line", user_id: null, completed_at: null },
    {
      id: 5,
      title: "Sweep Kitchen Line",
      user_id: 999,
      completed_at: "2026-07-25T15:00:00-05:00",
    },
  ],
};

test("maps local wall-clock date/times and completion attribution", () => {
  const out = mapApiListsToParsedTasks([LIST], "Ike's - Houston Heights", nameFor);
  const wipe = out.find((t) => t.task_name === "Wipe Down Tables")!;
  assert.equal(wipe.task_date, "2026-07-25");
  assert.equal(wipe.start_time, "10:00:00");
  assert.equal(wipe.due_time, "21:00:00");
  assert.equal(wipe.task_type, "Checkmark");
  assert.equal(wipe.is_complete, true);
  assert.equal(wipe.earliest_completion_at, "2026-07-25T13:43:59");
  assert.deepEqual(wipe.completers, ["Jose Mena"]);
  assert.equal(wipe.location_label, "Ike's - Houston Heights");
});

test("incomplete task carries no completion and stays incomplete", () => {
  const out = mapApiListsToParsedTasks([LIST], "L", nameFor);
  const t2 = out.find((t) => t.task_name === "Wipe Down Tables 2")!;
  assert.equal(t2.is_complete, false);
  assert.equal(t2.earliest_completion_at, null);
  assert.deepEqual(t2.completers, []);
});

test("repeated titles merge: any-complete wins, window widens, completers union", () => {
  const out = mapApiListsToParsedTasks([LIST], "L", nameFor);
  const sweeps = out.filter((t) => t.task_name === "Sweep Kitchen Line");
  assert.equal(sweeps.length, 1);
  const s = sweeps[0];
  assert.equal(s.is_complete, true);
  assert.equal(s.earliest_completion_at, "2026-07-25T12:25:35");
  assert.equal(s.latest_completion_at, "2026-07-25T15:00:00");
  // Resolved name + unresolved placeholder (user 999 has no crosswalk row).
  assert.deepEqual(s.completers.sort(), ["7shifts:999", "Jose Mena"].sort());
});

test("enumerateDates is inclusive and ordered", () => {
  assert.deepEqual(enumerateDates("2026-07-25", "2026-07-27"), [
    "2026-07-25",
    "2026-07-26",
    "2026-07-27",
  ]);
});
