/**
 * Unit tests for the triage detection pool helpers, plus text-level pins on
 * the matching rules (kickoff-employee-triage-mint-ui-2026-08-21.md §3f):
 * matching keys on the 7shifts user id, never on name.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findSimilarRosterNames,
  normalizeSevenShiftsUserId,
  type RosterNameRow,
} from "./detections.ts";

test("normalizeSevenShiftsUserId parses CP's text ids", () => {
  assert.equal(normalizeSevenShiftsUserId("8585453"), 8585453);
  assert.equal(normalizeSevenShiftsUserId(" 11313462 "), 11313462);
  // 0 = the known phantom class: representable (dismissable), never mintable.
  assert.equal(normalizeSevenShiftsUserId("0"), 0);
});

test("normalizeSevenShiftsUserId rejects unusable values", () => {
  assert.equal(normalizeSevenShiftsUserId(null), null);
  assert.equal(normalizeSevenShiftsUserId(undefined), null);
  assert.equal(normalizeSevenShiftsUserId(""), null);
  assert.equal(normalizeSevenShiftsUserId("   "), null);
  assert.equal(normalizeSevenShiftsUserId("abc"), null);
  assert.equal(normalizeSevenShiftsUserId("12.5"), null);
  assert.equal(normalizeSevenShiftsUserId("-3"), null);
  assert.equal(normalizeSevenShiftsUserId("1e3"), null);
});

const ROSTER: RosterNameRow[] = [
  { employee_code: "EMP-100142", employee_name: "Ryan Griffin", location_id: "loc-hranch" },
  { employee_code: "EMP-100150", employee_name: "Amy Segelhorst", location_id: "loc-fcol" },
  { employee_code: "EMP-100160", employee_name: "Jo Griffin", location_id: "loc-cpd" },
];

test("shared surname at the same location produces the caution hint", () => {
  // The Connor Griffin ≠ Ryan Griffin near-miss class (HRANCH, 2026-08).
  const hits = findSimilarRosterNames("Connor Griffin", "loc-hranch", ROSTER);
  assert.deepEqual(hits, [
    { employee_code: "EMP-100142", employee_name: "Ryan Griffin" },
  ]);
});

test("surname matches are location-scoped", () => {
  // Jo Griffin is at a different store — no hint.
  const hits = findSimilarRosterNames("Connor Griffin", "loc-longm", ROSTER);
  assert.deepEqual(hits, []);
});

test("shared FIRST name alone does not hint (deliberate scope)", () => {
  // Amy Roberts ≠ Amy Segelhorst is protected by id-keyed matching, not by
  // this hint — a shared-first-name hint would fire on every common name.
  const hits = findSimilarRosterNames("Amy Roberts", "loc-fcol", ROSTER);
  assert.deepEqual(hits, []);
});

test("exact full-name match hints even without a distinct surname token", () => {
  const hits = findSimilarRosterNames("amy segelhorst", "loc-fcol", ROSTER);
  assert.deepEqual(hits, [
    { employee_code: "EMP-100150", employee_name: "Amy Segelhorst" },
  ]);
});

test("no location (crosswalk gap) means no hint, not a crash", () => {
  assert.deepEqual(findSimilarRosterNames("Connor Griffin", null, ROSTER), []);
});

// ── Text-level pins (repo convention) ───────────────────────────────────────

const detectionsSrc = readFileSync(
  join(process.cwd(), "src/lib/triage/detections.ts"),
  "utf8"
);

test("CP read filters to uncoded schedule-discovered rows", () => {
  assert.match(detectionsSrc, /\.eq\("source", "discovered_from_schedule"\)/);
  assert.match(detectionsSrc, /\.is\("employee_code", null\)/);
  assert.match(
    detectionsSrc,
    /\.order\("first_seen_at", \{ ascending: true \}\)/,
    "oldest detection first (§3a)"
  );
});

test("exclusion is keyed on seven_shifts_user_id, never on name", () => {
  assert.match(
    detectionsSrc,
    /\.select\("seven_shifts_user_id"\)/,
    "EPD exclusion reads the 7shifts id"
  );
  for (const file of ["detections.ts", "enrich.ts"]) {
    const src = readFileSync(
      join(process.cwd(), "src/lib/triage", file),
      "utf8"
    );
    assert.doesNotMatch(
      src,
      /\.eq\("employee_name"/,
      `${file} must never query by name`
    );
    assert.doesNotMatch(
      src,
      /\.ilike\("employee_name"/,
      `${file} must never fuzzy-query by name`
    );
  }
});

test("the CP bridge is the only client shape detections.ts knows", () => {
  // The employee_directory read lives here and ONLY here; the module takes
  // clients as parameters and never constructs EPD's own.
  assert.match(detectionsSrc, /\.from\("employee_directory"\)/);
  assert.doesNotMatch(detectionsSrc, /@\/lib\/supabase/);
  assert.doesNotMatch(detectionsSrc, /createAdminClient/);
  const enrichSrc = readFileSync(
    join(process.cwd(), "src/lib/triage/enrich.ts"),
    "utf8"
  );
  assert.doesNotMatch(enrichSrc, /employee_directory/);
});
