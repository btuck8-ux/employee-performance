/**
 * Contract pins for /api/scores paging (THQ paging fix, 2026-08-25 §0) —
 * TEXT-LEVEL pins per repo convention.
 *
 * THQ shipped offset paging against this route and asked whether the sort
 * is stable. It was ordered — and NOT total: employee_code repeats once
 * per period (1,004 rows / 224 codes, largest tie group 9), and Postgres
 * guarantees nothing within ties across separate queries. Offset paging
 * over a partial order silently skips and duplicates rows at page
 * boundaries while reconciling to a plausible count, and at offset 1,000
 * the boundary lands inside a tie group with near-certainty. Neither side
 * can detect the corruption from outside.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const routeSrc = read("src/app/api/scores/route.ts");

test("/api/scores orders by a TOTAL key: (employee_code, period_label) — one row per pair by construction", () => {
  assert.match(
    routeSrc,
    /\.order\("employee_code", \{ ascending: true \}\)\s*\n\s*\.order\("period_label", \{ ascending: true \}\)/,
    "the period_label tiebreak makes the sort total; employee_code alone is a partial order"
  );
  // The tiebreak must sit on the SAME query chain as the range() paging.
  const orderIdx = routeSrc.indexOf('.order("period_label"');
  const rangeIdx = routeSrc.indexOf(".range(offset", orderIdx);
  assert.ok(orderIdx > 0 && rangeIdx > orderIdx, "tiebreak precedes the range on the paged query");
});

// ---- §4 (2026-08-25): the paging contract THQ builds against -------------

const { hasMore } = await import("./scores-paging.ts");
// (registerHooks not needed — scores-paging has no imports; direct .ts
// import resolves under the type-stripping runner.)

test("the 1,000/1,001 edge — the boundary neither side had crossed in five months", () => {
  // 1,000 rows total: one full page, then done.
  if (hasMore(0, 1000, 1000) !== false) throw new Error("full single page must end");
  // 1,001 rows: page one says more; page two returns 1 and ends.
  if (hasMore(0, 1000, 1001) !== true) throw new Error("1,001st row must be reachable");
  if (hasMore(1000, 1, 1001) !== false) throw new Error("final partial page must end");
  // The live shape: 1,004 rows at offset 1,000 → 4 rows, no more.
  if (hasMore(1000, 4, 1004) !== false) throw new Error("live boundary must end");
  // Empty result at any offset ends.
  if (hasMore(2000, 0, 1004) !== false) throw new Error("past-the-end must end");
});

test("§4a: the envelope THQ reads is exactly what the route emits, and `page` fails loudly", () => {
  assert.match(routeSrc, /pagination: \{\s*\n\s*limit,\s*\n\s*offset,\s*\n\s*count: total,\s*\n\s*has_more: hasMore\(offset, rows\.length, total\),/);
  // An ignored paging param serves page one forever — the same
  // undetectable-corruption class as the partial-order sort.
  assert.match(routeSrc, /searchParams\.has\("page"\)/);
  assert.match(routeSrc, /page is not a supported parameter/);
});

test("§4b: NO default quarter scope — period=all keeps meaning all (THQ's delta mechanism depends on it)", () => {
  // period defaults to latest and passes 'all' through unfiltered; a
  // current-quarter default would silently hide Q2 restatements from the
  // consumer that absorbs them via deltas. Paging carries the volume.
  assert.match(routeSrc, /url\.searchParams\.get\("period"\) \?\? "latest"/);
  assert.match(routeSrc, /period !== "latest" && period !== "all"/);
  assert.doesNotMatch(routeSrc, /currentQuarter\(/);
});
