/**
 * Contract pin for the CP surveys read (fetch.ts) — the ONLY CP-side
 * `surveys` read in the repo.
 *
 * CP mig 0055 (2026-08-17) added kind='homework' training-assignment rows to
 * CP's surveys table (location_id nullable). Homework is deliberately
 * excluded from EPD's survey-engagement feed (Tucker ruling 2026-08-17):
 * training compliance is THQ's signal. Without the kind filter, a
 * per-location homework row would be silently inherited and its respondents
 * would enter the assigned pool via the "evidently sent" fallback, inflating
 * survey_engagement_pct. TEXT-LEVEL pin per repo convention.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fetchSrc = readFileSync(
  join(process.cwd(), "src/lib/ingest/culture-pulse/fetch.ts"),
  "utf8"
);

test("CP surveys read filters to kind IN (weekly, one_off)", () => {
  const surveysRead = fetchSrc.match(
    /\.from\("surveys"\)[\s\S]*?"surveys"\s*\)/
  );
  assert.ok(surveysRead, "surveys read present");
  assert.match(
    surveysRead![0],
    /\.in\("kind", \["weekly", "one_off"\]\)/,
    "kind filter present on the surveys read (homework excluded)"
  );
});

test("no other CP surveys read exists without the kind filter", () => {
  // Every .from("surveys") occurrence in this file must be followed by the
  // kind filter before the fetchAll label closes.
  const occurrences = fetchSrc.match(/\.from\("surveys"\)/g) ?? [];
  assert.equal(occurrences.length, 1, "exactly one CP surveys read in fetch.ts");
});
