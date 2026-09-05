/**
 * W6 — composite-identity selection model + contract pins (MASTER sprint).
 * The packet's three cases and the interaction requirement, unit-tested on
 * the pure selection model the card actually uses; text-level pins hold the
 * fetch, the card, and the navigation exception to the design.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sliceKey,
  initialChecked,
  toggleChecked,
  selectedSlices,
  quarterSubset,
  belowFloorSlices,
  quarterBelowFloor,
  buildSliceList,
  attributionBelongsToSlice,
} from "./multi-location-selection.ts";
import type { LocationQuarterMetrics } from "./multi-location-metrics.ts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const EMPTY_MEAN = { sum: 0, n: 0 };
function lqm(o: Partial<LocationQuarterMetrics>): LocationQuarterMetrics {
  return {
    employeeId: "emp",
    locationId: "loc",
    quarterId: "q",
    belowFloor: false,
    attendance: { num: 0, den: 0 },
    onTime: { num: 0, den: 0 },
    onTimeGrace: { num: 0, den: 0 },
    surveyEngagement: { num: 0, den: 0 },
    csRating: EMPTY_MEAN,
    tattleRating: EMPTY_MEAN,
    tattleFood: EMPTY_MEAN,
    tattleAccuracy: EMPTY_MEAN,
    tattleSpeed: EMPTY_MEAN,
    tattleQuantity: 0,
    reviewQuantity: 0,
    avgTaskListCompletionPct: null,
    ...o,
  };
}

// ---- case (a): ONE employee row transferred between stores over time ----

test("case (a): one transferred row yields two independently selectable slices", () => {
  const slices = [
    { employeeId: "E1", locationId: "OLD" },
    { employeeId: "E1", locationId: "NEW" },
  ];
  assert.notEqual(sliceKey(slices[0]), sliceKey(slices[1]));

  let checked = initialChecked(slices);
  assert.deepEqual(selectedSlices(slices, checked).length, 2);

  // old store only
  checked = toggleChecked(checked, sliceKey(slices[1]), false);
  let sel = selectedSlices(slices, checked);
  assert.deepEqual(sel, [slices[0]]);

  // new store only
  checked = toggleChecked(checked, sliceKey(slices[0]), false);
  checked = toggleChecked(checked, sliceKey(slices[1]), true);
  sel = selectedSlices(slices, checked);
  assert.deepEqual(sel, [slices[1]]);

  // both again
  checked = toggleChecked(checked, sliceKey(slices[0]), true);
  assert.equal(selectedSlices(slices, checked).length, 2);
});

// ---- case (b): multiple sibling rows at different stores ----

test("case (b): sibling rows at different stores select independently", () => {
  const slices = [
    { employeeId: "E1", locationId: "HRANCH" },
    { employeeId: "E2", locationId: "LONGM" },
  ];
  let checked = initialChecked(slices);
  checked = toggleChecked(checked, sliceKey(slices[0]), false);
  assert.deepEqual(selectedSlices(slices, checked), [slices[1]]);
});

// ---- case (c): multiple location rows within a SINGLE quarter ----

test("case (c): two store records in ONE quarter subset independently — never collapse or drop", () => {
  const rows = [
    lqm({ employeeId: "E1", locationId: "OLD", quarterId: "Q3", attendance: { num: 2, den: 4 } }),
    lqm({ employeeId: "E1", locationId: "NEW", quarterId: "Q3", attendance: { num: 18, den: 18 } }),
  ];
  const both = initialChecked(rows);
  assert.equal(quarterSubset(rows, "Q3", both).length, 2, "both rows survive in one quarter");

  const oldOnly = toggleChecked(both, sliceKey(rows[1]), false);
  const subsetOld = quarterSubset(rows, "Q3", oldOnly);
  assert.equal(subsetOld.length, 1);
  assert.equal(subsetOld[0].locationId, "OLD");

  const newOnly = toggleChecked(both, sliceKey(rows[0]), false);
  const subsetNew = quarterSubset(rows, "Q3", newOnly);
  assert.equal(subsetNew.length, 1);
  assert.equal(subsetNew[0].locationId, "NEW");
});

// ---- below-floor: not-computable, never 0, and attributed ----

test("a below-floor slice is marked and surfaced, never zero", () => {
  assert.equal(quarterBelowFloor("2026-03-31", "2026-07-30"), true);
  assert.equal(quarterBelowFloor("2026-09-30", "2026-07-30"), false);
  // NULL floor = NO floor (NOLA) — never read as epoch or today.
  assert.equal(quarterBelowFloor("2020-03-31", null), false);

  const rows = [
    lqm({ employeeId: "E1", locationId: "FCCSU", quarterId: "Q1", belowFloor: true }),
    lqm({ employeeId: "E1", locationId: "HOU", quarterId: "Q1", belowFloor: false }),
  ];
  const checked = initialChecked(rows);
  const floored = belowFloorSlices(rows, "Q1", checked);
  assert.equal(floored.length, 1);
  assert.equal(floored[0].locationId, "FCCSU");
});

// ---- fetch-level fixtures (Codex CP3): slice dedup + case-(b) totals ----

test("slice dedup: a record at the roster row's current store yields ONE slice, not two", () => {
  const slices = buildSliceList(
    [{ id: "E1", location_id: "HOU" }],
    [
      { employee_id: "E1", location_id: "HOU" }, // same store as roster — dedup
      { employee_id: "E1", location_id: "FCOL" }, // transfer history — new slice
      { employee_id: "E1", location_id: null }, // pre-093 nulls never mint slices
    ]
  );
  assert.deepEqual(slices, [
    { employeeId: "E1", locationId: "HOU" },
    { employeeId: "E1", locationId: "FCOL" },
  ]);
  // single-location person: exactly one slice → the fetch returns null
  assert.equal(
    buildSliceList([{ id: "E2", location_id: "COS" }], [
      { employee_id: "E2", location_id: "COS" },
    ]).length,
    1
  );
});

test("case (b) attribution totals: per-slice buckets sum to the old employee-only totals", () => {
  // Case (b): two sibling rows; every survey is left at its own row's store
  // (structurally true pre-transfer). Bucketing by slice must not lose or
  // double-count anything relative to bucketing by employee alone.
  const slices = [
    { employeeId: "E1", locationId: "HRANCH" },
    { employeeId: "E2", locationId: "LONGM" },
  ];
  const surveys = [
    { emp: "E1", loc: "HRANCH" },
    { emp: "E1", loc: "HRANCH" },
    { emp: "E2", loc: "LONGM" },
  ];
  const perSlice = slices.map(
    (s) => surveys.filter((x) => attributionBelongsToSlice(x.emp, x.loc, s)).length
  );
  assert.deepEqual(perSlice, [2, 1]);
  const byEmployeeOnly = ["E1", "E2"].map(
    (e) => surveys.filter((x) => x.emp === e).length
  );
  assert.equal(
    perSlice.reduce((a, b) => a + b, 0),
    byEmployeeOnly.reduce((a, b) => a + b, 0)
  );
  // Case (a) split: one row, surveys at two stores — buckets split cleanly.
  const aSlices = [
    { employeeId: "E3", locationId: "OLD" },
    { employeeId: "E3", locationId: "NEW" },
  ];
  const aSurveys = [
    { emp: "E3", loc: "OLD" },
    { emp: "E3", loc: "NEW" },
    { emp: "E3", loc: "NEW" },
  ];
  assert.deepEqual(
    aSlices.map((s) => aSurveys.filter((x) => attributionBelongsToSlice(x.emp, x.loc, s)).length),
    [1, 2]
  );
});

test("the fetch uses the tested helpers verbatim (no inline drift)", () => {
  assert.match(fetchSrc, /buildSliceList\(empRows, records\)/);
  assert.match(fetchSrc, /attributionBelongsToSlice\(/);
});

test("attribution paging carries tie-breakers past employee_id (Codex CP3)", () => {
  assert.match(fetchSrc, /\.order\("tattle_survey_id", \{ ascending: true \}\)/);
  assert.match(fetchSrc, /\.order\("customer_review_id", \{ ascending: true \}\)/);
});

// ---- contract pins: fetch layer (defects 1–4) ----

const fetchSrc = read("src/lib/multi-location-fetch.ts");

test("defect 1 pinned: the render gate counts SLICES, not employee rows", () => {
  assert.match(fetchSrc, /sliceList\.length < 2/);
  assert.doesNotMatch(fetchSrc, /siblings\.length < 2/);
});

test("defect 2 pinned: the performance_records query selects location_id", () => {
  assert.match(
    fetchSrc,
    /"employee_id, location_id, surveys_assigned, surveys_completed, avg_task_list_completion_pct, report_periods\(/
  );
});

test("defect 3 pinned: the record map keys on the FULL composite (employee, location, quarter)", () => {
  assert.match(fetchSrc, /`\$\{r\.employee_id\}::\$\{r\.location_id\}::\$\{r\.report_periods!\.id\}`/);
});

test("defect 4 pinned: computeMetricsFromEntries receives the store's own metricsStartFloor", () => {
  assert.match(fetchSrc, /metricsStartFloor: meta\.metricsStart/);
});

test("RBAC path preserved: the fetch uses only the caller's client — no admin/service client", () => {
  assert.doesNotMatch(fetchSrc, /createAdminClient|service_role|SUPABASE_SERVICE_ROLE_KEY/);
});

test("attribution buckets tattles/reviews per slice location", () => {
  assert.match(fetchSrc, /t\.tattle_surveys\.location_id,\s*\n\s*s/);
  assert.match(fetchSrc, /r\.customer_reviews\.location_id,\s*\n\s*s/);
});

// ---- contract pins: the card (defect 5 + navigation exception + row 10) ----

const cardSrc = read("src/components/employee/MultiLocationCard.tsx");

test("defect 5 pinned: checkbox state, React keys and the subset filter all ride sliceKey", () => {
  assert.match(cardSrc, /initialChecked\(siblings\)/);
  assert.match(cardSrc, /key=\{sliceKey\(s\)\}/);
  assert.match(cardSrc, /checked=\{checked\[sliceKey\(s\)\]/);
  assert.match(cardSrc, /quarterSubset\(perLocationQuarter, q\.id, checked\)/);
  // No surface keys on bare employeeId any more.
  assert.doesNotMatch(cardSrc, /key=\{s\.employeeId\}/);
  assert.doesNotMatch(cardSrc, /checked\[s\.employeeId\]/);
});

test("NAVIGATION EXCEPTION pinned: employee URLs are built from the bare employeeId, never a composite", () => {
  assert.match(cardSrc, /href=\{`\/dashboard\/employees\/\$\{s\.employeeId\}`\}/);
  assert.doesNotMatch(cardSrc, /employees\/\$\{sliceKey/);
  assert.doesNotMatch(cardSrc, /employees\/\$\{[^}]*locationId/);
});

test("row 10 pinned: the task-list cell is an unconditional dash — one selection or many", () => {
  // The dash cell carries no conditional: selection state cannot change it.
  assert.match(cardSrc, /<td className="py-2 pr-3 text-slate-400">—<\/td>/);
  assert.match(cardSrc, /UNCONDITIONAL dash — at one selection and at many/);
  assert.doesNotMatch(cardSrc, /selected\.length[^\n]*—/);
});

test("the card says what it is: metrics, not scores", () => {
  assert.match(cardSrc, /Multi-location metrics/);
  assert.match(cardSrc, /combined CS Score and Total\s+Impact Score are not shown here/i);
});

test("below-floor slices are attributed by name in the quarter row", () => {
  assert.match(cardSrc, /belowFloorSlices\(/);
  assert.match(cardSrc, /below data floor/);
});
