/**
 * A green cp_schedule run must not conceal lost rows (2026-08-31).
 *
 * The failure this pins: LONGM ran 2026-08-30 and 08-31 at
 *   status: success · rows_in 105 · upserted 98 · skipped 2
 *   unmatched_rows: 2 · unmatched: ["Taggart Dickson"]
 * Both nights green, four shifts silently absent from the scored denominator.
 * The only trace was a count buried in the detail JSON.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const orchSrc = readFileSync(
  join(process.cwd(), "src/lib/ingest/culture-pulse/schedule-orchestrator.ts"),
  "utf8"
);

test("unmatched rows reach error_text, so a successful run still shows the loss", () => {
  assert.match(orchSrc, /stats\.unmatched_rows > 0/);
  assert.match(orchSrc, /row\(s\) skipped unmatched/);
  assert.match(orchSrc, /outcome\.error_text = lossNotes\.join/);
});

test("the skipped rows are NAMED, not just counted", () => {
  // The count alone is what hid this: on 08-31, 22 of 24 unmatched were
  // newly-minted hires that self-heal once CP stamps them, and 2 were a
  // permanent identity mismatch. Only names separate those classes.
  assert.match(orchSrc, /stats\.unmatched\b[\s\S]{0,80}\.slice\(0, 10\)/);
});

test("inactive skips are surfaced too — a second silent-loss channel", () => {
  assert.match(orchSrc, /stats\.inactive_rows > 0/);
  assert.match(orchSrc, /row\(s\) skipped inactive/);
});

test("status is NOT falsified — a run that upserted good rows stays success", () => {
  // ingest_runs_status_chk permits only running/success/empty/error. Marking a
  // 98-good-row run 'error' would be a lie and would poison the empty-streak
  // guard; the visibility rides error_text instead.
  assert.match(orchSrc, /outcome\.status = stats\.entries_upserted > 0 \? "success" : "empty"/);
  assert.doesNotMatch(orchSrc, /unmatched_rows > 0[\s\S]{0,120}status = "error"/);
});

test("recompute failures keep their own note — the new notes ADD, never replace", () => {
  assert.match(orchSrc, /recompute failure\(s\); see detail/);
  assert.match(orchSrc, /lossNotes\.push/);
});
