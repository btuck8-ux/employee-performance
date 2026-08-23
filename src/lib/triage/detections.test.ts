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
  buildExclusionPairs,
  findSimilarRosterNames,
  isDetectionExcluded,
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

// ── Pair-keyed exclusion (§4-A1, 2026-08-23 multi-location sprint) ──────────
//
// Real-shape fixture: Liv Sandifer holds 7shifts id 10418605 at TWO stores
// (HRANCH EMP-100148 + LONGM EMP-100170) — one of the six live multi-site
// people. A roster row at one site must exclude the detection AT THAT SITE
// ONLY; the same id detected at a third site is a genuine new detection.

const CP_TO_EPD = new Map([
  ["cp-hranch", "epd-hranch"],
  ["cp-longm", "epd-longm"],
  ["cp-cpd", "epd-cpd"],
]);

test("a roster row excludes the detection at its own site only", () => {
  const excluded = buildExclusionPairs([
    { seven_shifts_user_id: 10418605, location_id: "epd-hranch" },
  ]);
  assert.equal(
    isDetectionExcluded(10418605, "cp-hranch", CP_TO_EPD, excluded),
    true,
    "already minted at HRANCH — the HRANCH detection drops"
  );
  assert.equal(
    isDetectionExcluded(10418605, "cp-cpd", CP_TO_EPD, excluded),
    false,
    "the same person picking up shifts at CPD is a NEW detection"
  );
});

test("a dismissal excludes at its own site only", () => {
  const excluded = buildExclusionPairs([
    { seven_shifts_user_id: 10418605, location_id: "epd-longm" },
  ]);
  assert.equal(
    isDetectionExcluded(10418605, "cp-longm", CP_TO_EPD, excluded),
    true
  );
  assert.equal(
    isDetectionExcluded(10418605, "cp-hranch", CP_TO_EPD, excluded),
    false
  );
});

test("string ids from the wire build the same pairs as numbers", () => {
  // employees.seven_shifts_user_id arrives as bigint→number, dismissals may
  // round-trip as strings — both must land on one pair key.
  const excluded = buildExclusionPairs([
    { seven_shifts_user_id: "10418605", location_id: "epd-hranch" },
  ]);
  assert.equal(
    isDetectionExcluded(10418605, "cp-hranch", CP_TO_EPD, excluded),
    true
  );
});

test("unparseable ids and un-crosswalked sites stay visible", () => {
  const excluded = buildExclusionPairs([
    { seven_shifts_user_id: 10418605, location_id: "epd-hranch" },
  ]);
  assert.equal(
    isDetectionExcluded(null, "cp-hranch", CP_TO_EPD, excluded),
    false,
    "no usable id — a real person the admin should still see"
  );
  assert.equal(
    isDetectionExcluded(10418605, "cp-unmapped", CP_TO_EPD, excluded),
    false,
    "no crosswalk entry — no derivable pair, stays visible"
  );
});

test("rows with unusable ids contribute nothing to the exclusion set", () => {
  const excluded = buildExclusionPairs([
    { seven_shifts_user_id: null, location_id: "epd-hranch" },
    { seven_shifts_user_id: "not-a-number", location_id: "epd-longm" },
  ]);
  assert.equal(excluded.size, 0);
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

test("exclusion is keyed on (seven_shifts_user_id, location_id), never on name", () => {
  assert.match(
    detectionsSrc,
    /\.select\("seven_shifts_user_id, location_id, employee_code"\)/,
    "EPD roster exclusion reads the id + site pair"
  );
  assert.match(
    detectionsSrc,
    /\.select\("seven_shifts_user_id, location_id"\)/,
    "dismissal exclusion reads the id + site pair (mig 053)"
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
