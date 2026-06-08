/**
 * Unit tests for the empty-streak counter (Step 3 guard).
 *
 * Runs on Node's built-in test runner with native TypeScript type-stripping —
 * no test framework dependency:
 *
 *   node --test src/lib/ingest/sevenshifts/streak.test.ts
 *   npm test            # runs every *.test.ts under the ingest path
 *
 * streak.ts imports only types from sibling modules, so type-stripping leaves it
 * with zero runtime imports and the counter is exercised in true isolation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { countLeadingEmpty, EMPTY_STREAK_THRESHOLD } from "./streak.ts";

// Input is newest-first (index 0 = tonight), matching the started_at DESC query.

test("empty · empty · empty → streak 3 (fires)", () => {
  const streak = countLeadingEmpty(["empty", "empty", "empty"]);
  assert.equal(streak, 3);
  assert.ok(streak >= EMPTY_STREAK_THRESHOLD);
});

test("a longer run counts every consecutive empty night", () => {
  assert.equal(countLeadingEmpty(["empty", "empty", "empty", "empty", "empty"]), 5);
});

test("a success in between resets the streak (empty,empty,success,empty → 2, no fire)", () => {
  // oldest-first this is empty,success,empty,empty; newest-first as queried:
  const streak = countLeadingEmpty(["empty", "empty", "success", "empty"]);
  assert.equal(streak, 2);
  assert.ok(streak < EMPTY_STREAK_THRESHOLD);
});

test("today-only empty → streak 1 (no fire)", () => {
  const streak = countLeadingEmpty(["empty", "success", "success"]);
  assert.equal(streak, 1);
  assert.ok(streak < EMPTY_STREAK_THRESHOLD);
});

test("recovery tonight (success first) → streak 0", () => {
  assert.equal(countLeadingEmpty(["success", "empty", "empty", "empty"]), 0);
});

test("an error night breaks the streak just like a success", () => {
  // tonight empty, but an error two nights ago caps the consecutive-empty count.
  assert.equal(countLeadingEmpty(["empty", "error", "empty", "empty"]), 1);
});

test("a running row at the head is non-empty and yields streak 0", () => {
  assert.equal(countLeadingEmpty(["running", "empty", "empty", "empty"]), 0);
});

test("empty history → streak 0", () => {
  assert.equal(countLeadingEmpty([]), 0);
});

test("threshold is 3 consecutive nights", () => {
  assert.equal(EMPTY_STREAK_THRESHOLD, 3);
});
