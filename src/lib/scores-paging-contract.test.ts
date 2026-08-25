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
