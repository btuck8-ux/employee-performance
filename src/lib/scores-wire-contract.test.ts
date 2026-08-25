/**
 * Contract pins for WHICH endpoint the consumers actually poll (2026-08-25)
 * — TEXT-LEVEL pins per repo convention.
 *
 * The defect this serves reached a partner: "the flip's numbers are live
 * on your wire" was announced off /api/scores/range (live compute, polled
 * by nobody) while CP and THQ poll /api/scores (stored,
 * performance_records). THQ disproved it from computed_at stamps 34
 * minutes after the deploy. Both routes now say who polls them, AGENTS.md
 * carries the trap, and these pins make the next person's grep land right
 * — a one-line comment would have prevented a wrong memo.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const scoresSrc = read("src/app/api/scores/route.ts");
const rangeSrc = read("src/app/api/scores/range/route.ts");
const agentsSrc = read("AGENTS.md");

test("/api/scores is STORED: reads the views, never the live compute", () => {
  assert.match(scoresSrc, /v_employee_scores/);
  assert.match(scoresSrc, /v_employee_scores_latest/);
  assert.doesNotMatch(
    scoresSrc,
    /computeMetricsForRange/,
    "the consumer wire must stay stored — a live compute here would silently change what partners receive on deploy"
  );
});

test("both routes name their pollers; range disclaims consumers in as many words", () => {
  assert.match(scoresSrc, /THIS IS THE CONSUMER WIRE, AND IT IS STORED/);
  assert.match(scoresSrc, /Culture Pulse daily 09:00 UTC/);
  assert.match(scoresSrc, /Training HQ daily 11:15 UTC/);
  assert.match(
    rangeSrc,
    /CP AND THQ DO NOT POLL THIS ROUTE — \/api\/scores IS THE CONSUMER WIRE/
  );
});

test("the restatement rule is stated on the wire and in the trap-list", () => {
  // A deploy changes what the NEXT recompute produces; it changes nothing
  // already stored. A restatement is not real until performance_records is
  // rewritten.
  assert.match(scoresSrc, /A restatement is not real on this\s*\n?\s*\* wire until performance_records is rewritten/);
  assert.match(agentsSrc, /`\/api\/scores` is STORED, `\/api\/scores\/range` is LIVE/);
  assert.match(agentsSrc, /A restatement is not real until\s*\n?\s*`performance_records` is rewritten/);
  assert.match(agentsSrc, /computed_at/);
});
