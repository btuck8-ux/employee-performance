/**
 * Wire-contract pins for GET /api/scores/range (2026-08-14 range-API
 * sprint). The contract is the THQ memo
 * (memo-to-training-hq-range-contract-2026-08-14.md), accepted VERBATIM by
 * THQ — these tests pin:
 *
 *   (a) the 20 wire fields in locked order (3 identity + 9 metrics + 6
 *       counts, wire names identical to /api/scores mig 045/048; + the 2
 *       attendance counts appended 2026-08-26, THQ wire item 2 — 18 → 20)
 *       and that composites are ABSENT (v1 scope, THQ-confirmed);
 *   (b) param validation: calendar-valid dates, start <= end, floor
 *       2026-01-01, window <= 366 days, location_code CSV against the 8
 *       codes, strict EMP-NNNNNN employee_code, page/limit strictness with
 *       default 25 / max 50 (the cap THQ explicitly asked to keep);
 *   (c) null discipline: metric nulls reach the wire as null (never 0),
 *       counts are honest integers;
 *   (d) deterministic pagination order (location_code, employee_code);
 *   (e) route-file text: maxDuration 300, force-dynamic, the shared
 *       SCORES_FEED_TOKEN bearer, and the quotable DATA FLOORS block the
 *       ship report + THQ's "Not computable" UI state both reference.
 *
 * scores-feed-contract.test.ts (the 26-column /api/scores pin) is a
 * SEPARATE file and stays byte-identical — this route touches nothing it
 * covers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Module from "node:module";

// @types/node v20 predates registerHooks (runtime-present on Node 24), so
// type the surface we use ourselves.
interface ResolveResult {
  url: string;
  shortCircuit?: boolean;
  format?: string | null;
}
type NextResolve = (specifier: string, context?: unknown) => ResolveResult;
const { registerHooks } = Module as unknown as {
  registerHooks: (hooks: {
    resolve: (
      specifier: string,
      context: unknown,
      nextResolve: NextResolve
    ) => ResolveResult;
  }) => void;
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    let spec = specifier;
    if (spec.startsWith("@/")) {
      // tsconfig maps "@/*" → "./src/*"; this file lives in src/lib/.
      spec = new URL(`../${spec.slice(2)}`, import.meta.url).href;
    }
    try {
      return nextResolve(spec, context);
    } catch (err) {
      if (!spec.endsWith(".ts") && /^(\.{1,2}\/|file:)/.test(spec)) {
        return nextResolve(`${spec}.ts`, context);
      }
      throw err;
    }
  },
});

const {
  RANGE_FEED_FIELDS,
  RANGE_FEED_DEFAULT_LIMIT,
  RANGE_FEED_MAX_LIMIT,
  compareRangeFeedMembers,
  toRangeFeedRow,
  validateRangeParams,
  windowDays,
} = await import("./range-feed.ts");
type RangeMetricsT = import("./performance-recompute.ts").RangeMetrics;

// Known location codes are INJECTED by the route from public.locations —
// the DB owns the fact, the validator keeps no copy (LOCATION_CODES packet
// 2026-08-26). Tests exercise the validator with a fixture set; the codes
// here are arbitrary fixture strings, not a roster copy.
const FIXTURE_CODES = ["CPD", "HOU"];
const validateWith = (sp: URLSearchParams) =>
  validateRangeParams(sp, FIXTURE_CODES);

const ROUTE_FILE = join(
  process.cwd(),
  "src/app/api/scores/range/route.ts"
);
const routeSrc = readFileSync(ROUTE_FILE, "utf8");

// ---- (a) wire shape ----

test("20 wire fields in locked order: 3 identity + 9 metrics + 6 counts + 2 attendance counts", () => {
  assert.deepEqual(
    [...RANGE_FEED_FIELDS],
    [
      "employee_code",
      "location_code",
      "employee_name",
      "on_time_grace_pct",
      "attendance_pct",
      "survey_engagement_pct",
      "customer_service_rating",
      "tattle_rating",
      "tattle_score_food_quality",
      "tattle_score_accuracy",
      "tattle_score_speed_of_service",
      "avg_task_list_completion_pct",
      "surveys_assigned",
      "surveys_completed",
      "customer_review_quantity",
      "tattle_quantity",
      "tasks_accountable",
      "tasks_completed",
      // Appended 2026-08-26 (THQ wire item 2, packet 5 §7.3): "0 of 5 is a
      // fact" — the counts substantiate the percentage. APPENDED, never
      // reordered — the first 18 stay byte-identical for THQ's parser.
      "scheduled_count",
      "attended_count",
    ]
  );
});

test("composites are absent in v1 — no fields, no half-built hooks", () => {
  for (const banned of ["customer_service_score", "total_impact_score"]) {
    assert.ok(
      !RANGE_FEED_FIELDS.includes(
        banned as (typeof RANGE_FEED_FIELDS)[number]
      ),
      `${banned} must not be a wire field`
    );
  }
});

// ---- fixtures ----

function params(q: Record<string, string>): URLSearchParams {
  return new URLSearchParams(q);
}

const VALID = { start: "2026-06-01", end: "2026-06-30" };

function metricsFixture(overrides: Partial<RangeMetricsT>): RangeMetricsT {
  // Only the 15 wire-relevant fields matter to toRangeFeedRow; the rest of
  // RangeMetrics (tips, kitchen, composites, breakdowns) is deliberately
  // untouched by the range feed, so a partial cast keeps this fixture from
  // coupling the test to engine internals.
  return {
    on_time_grace_pct: null,
    attendance_pct: null,
    survey_engagement_pct: null,
    customer_service_rating: null,
    tattle_rating: null,
    tattle_score_food_quality: null,
    tattle_score_accuracy: null,
    tattle_score_speed_of_service: null,
    avg_task_list_completion_pct: null,
    surveys_assigned: 0,
    surveys_completed: 0,
    customer_review_quantity: 0,
    tattle_quantity: 0,
    tasks_accountable: 0,
    tasks_completed: 0,
    scheduled_count: 0,
    attended_count: 0,
    attendance_denominator_excluded: false,
    // Present on the engine result but NEVER emitted on the wire (the
    // cover-ratio guard flag included — Codex nit 2026-08-25):
    customer_service_score: 87.5,
    total_impact_score: 91.2,
    cover_dominated: false,
    ...overrides,
  } as RangeMetricsT;
}

const EMP = {
  employee_code: "EMP-100001",
  location_code: "CPD",
  employee_name: "Test Person",
};

// ---- (b) param validation ----

test("valid params: defaults page 1 / limit 25, empty location filter", () => {
  const v = validateWith(params(VALID));
  assert.ok(v.ok);
  assert.deepEqual(v.params, {
    start: "2026-06-01",
    end: "2026-06-30",
    locationCodes: [],
    employeeCode: null,
    page: 1,
    limit: RANGE_FEED_DEFAULT_LIMIT,
  });
  assert.equal(RANGE_FEED_DEFAULT_LIMIT, 25);
  assert.equal(RANGE_FEED_MAX_LIMIT, 50);
});

test("start and end are required", () => {
  assert.ok(!validateWith(params({ start: "2026-06-01" })).ok);
  assert.ok(!validateWith(params({ end: "2026-06-30" })).ok);
  assert.ok(!validateWith(params({})).ok);
});

test("calendar validity: pattern-passing junk like 2026-13-99 is rejected", () => {
  for (const bad of ["2026-13-01", "2026-02-30", "2026-00-10", "junk", "2026-6-1"]) {
    const v = validateWith(params({ start: bad, end: "2026-06-30" }));
    assert.ok(!v.ok, `${bad} must be rejected`);
  }
});

test("start <= end, start >= 2026-01-01", () => {
  assert.ok(
    !validateWith(params({ start: "2026-07-01", end: "2026-06-30" })).ok
  );
  assert.ok(
    !validateWith(params({ start: "2025-12-31", end: "2026-01-31" })).ok
  );
  assert.ok(
    validateWith(params({ start: "2026-01-01", end: "2026-01-01" })).ok,
    "single-day window at the floor is valid"
  );
});

test("window cap: 366 inclusive days passes, 367 fails", () => {
  assert.equal(windowDays("2026-01-01", "2027-01-01"), 366);
  assert.ok(
    validateWith(params({ start: "2026-01-01", end: "2027-01-01" })).ok
  );
  assert.ok(
    !validateWith(params({ start: "2026-01-01", end: "2027-01-02" })).ok
  );
});

test("location_code CSV: valid codes pass (deduped), unknown/malformed fail", () => {
  const v = validateWith(
    params({ ...VALID, location_code: "CPD,HOU,CPD" })
  );
  assert.ok(v.ok);
  assert.deepEqual(v.params.locationCodes, ["CPD", "HOU"]);
  assert.ok(
    !validateWith(params({ ...VALID, location_code: "CPD,NOPE" })).ok
  );
  assert.ok(
    !validateWith(params({ ...VALID, location_code: "CPD,," })).ok
  );
  assert.ok(
    !validateWith(params({ ...VALID, location_code: "" })).ok
  );
});

test("employee_code: strict EMP-NNNNNN", () => {
  const v = validateWith(
    params({ ...VALID, employee_code: "EMP-100001" })
  );
  assert.ok(v.ok);
  assert.equal(v.params.employeeCode, "EMP-100001");
  for (const bad of ["100001", "EMP-1", "emp-100001", "EMP-100001; drop"]) {
    assert.ok(
      !validateWith(params({ ...VALID, employee_code: bad })).ok,
      `${bad} must be rejected`
    );
  }
});

test("page/limit: strict integers, limit capped at 50, junk is a 400 not a silent default", () => {
  const ok = validateWith(params({ ...VALID, page: "3", limit: "50" }));
  assert.ok(ok.ok);
  assert.equal(ok.params.page, 3);
  assert.equal(ok.params.limit, 50);
  const badCases: Record<string, string>[] = [
    { page: "0" },
    { page: "-1" },
    { page: "1.5" },
    { page: "abc" },
    // Infinity-coercing digit string must 400, not serialize page as null.
    { page: "9".repeat(400) },
    { limit: "0" },
    { limit: "51" },
    { limit: "abc" },
    { limit: "-5" },
  ];
  for (const bad of badCases) {
    assert.ok(
      !validateWith(params({ ...VALID, ...bad })).ok,
      `${JSON.stringify(bad)} must be rejected`
    );
  }
});

// ---- (c) null discipline ----

test("metric nulls pass through as null — never coalesced to 0", () => {
  const row = toRangeFeedRow(EMP, metricsFixture({}));
  for (const key of [
    "on_time_grace_pct",
    "attendance_pct",
    "survey_engagement_pct",
    "customer_service_rating",
    "tattle_rating",
    "tattle_score_food_quality",
    "tattle_score_accuracy",
    "tattle_score_speed_of_service",
    "avg_task_list_completion_pct",
  ] as const) {
    assert.equal(row[key], null, `${key} must stay null`);
  }
});

test("computed values and counts pass through untouched; composites never leak", () => {
  const row = toRangeFeedRow(
    EMP,
    metricsFixture({
      attendance_pct: 96.5,
      tattle_rating: 4.8,
      surveys_assigned: 4,
      surveys_completed: 3,
      tasks_accountable: 12,
      tasks_completed: 11,
    })
  );
  assert.equal(row.attendance_pct, 96.5);
  assert.equal(row.tattle_rating, 4.8);
  assert.equal(row.surveys_assigned, 4);
  assert.equal(row.surveys_completed, 3);
  assert.equal(row.tasks_accountable, 12);
  assert.equal(row.tasks_completed, 11);
  assert.deepEqual(Object.keys(row), [...RANGE_FEED_FIELDS]);
  assert.ok(!("customer_service_score" in row));
  assert.ok(!("total_impact_score" in row));
});

test("ruling 8 on the wire: an excluded non-puncher's attendance counts are null, never 0", () => {
  // The compute path zeroes the counts on its excluded branch — those zeros
  // are internal placeholders, not facts (the person's scheduled days
  // exist; they are deliberately not judged). toRangeFeedRow must map them
  // to null, the feed's not-computed encoding.
  const excluded = toRangeFeedRow(
    EMP,
    metricsFixture({
      attendance_denominator_excluded: true,
      scheduled_count: 0,
      attended_count: 0,
      attendance_pct: null,
    })
  );
  assert.equal(excluded.scheduled_count, null);
  assert.equal(excluded.attended_count, null);
  // A judgeable employee's counts pass through as integers — including an
  // honest 0 (a wholly-below-floor window has zero judgeable days).
  const scored = toRangeFeedRow(
    EMP,
    metricsFixture({ scheduled_count: 5, attended_count: 4 })
  );
  assert.equal(scored.scheduled_count, 5);
  assert.equal(scored.attended_count, 4);
  const floored = toRangeFeedRow(EMP, metricsFixture({}));
  assert.equal(floored.scheduled_count, 0);
  assert.equal(floored.attended_count, 0);
});

// ---- (d) deterministic pagination order ----

test("sort is (location_code, employee_code) ascending — pages never shuffle", () => {
  const unsorted = [
    { location_code: "HOU", employee_code: "EMP-100001" },
    { location_code: "CPD", employee_code: "EMP-100009" },
    { location_code: "CPD", employee_code: "EMP-100002" },
    { location_code: "COS", employee_code: "EMP-100500" },
  ];
  const sorted = [...unsorted].sort(compareRangeFeedMembers);
  assert.deepEqual(sorted, [
    { location_code: "COS", employee_code: "EMP-100500" },
    { location_code: "CPD", employee_code: "EMP-100002" },
    { location_code: "CPD", employee_code: "EMP-100009" },
    { location_code: "HOU", employee_code: "EMP-100001" },
  ]);
});

// ---- (e) route-file text pins ----

test("route: maxDuration 300, force-dynamic, shared SCORES_FEED_TOKEN bearer at a CALL site", () => {
  assert.match(routeSrc, /export const maxDuration = 300/);
  assert.match(routeSrc, /export const dynamic = "force-dynamic"/);
  // Call-site match, not identifier presence (Codex review): a dead import
  // or comment would not satisfy these.
  assert.match(
    routeSrc,
    /requireBearer\(\s*request,\s*process\.env\.SCORES_FEED_TOKEN/
  );
});

test("route: carries the quotable DATA FLOORS block (ship-report + THQ UI dependency)", () => {
  assert.match(routeSrc, /DATA FLOORS/);
  for (const key of [
    "on_time_grace_pct",
    "attendance_pct",
    "survey_engagement_pct",
    "customer_service_rating",
    "tattle_rating",
    "avg_task_list_completion_pct",
  ]) {
    assert.match(
      routeSrc,
      new RegExp(key),
      `floor block must cover ${key}`
    );
  }
});

test("route: reuses computeMetricsForRange at a call site (no parallel scoring math)", () => {
  assert.match(routeSrc, /await computeMetricsForRange\(/);
});

test("route: envelope carries location_floors (THQ wire item 3) — store-scoped, zero-row-survivable", () => {
  // A floor is a property of a STORE; the envelope key survives a zero-row
  // response (a window wholly below a store's floor answers with the
  // floor, never a bare empty array). THQ DECLINED a correction-coverage
  // envelope field — do not add one.
  assert.match(routeSrc, /location_floors: locationFloors/);
  assert.match(routeSrc, /await fetchLocationFloors\(/);
  assert.doesNotMatch(routeSrc, /correction_coverage|corrections_applied/);
});
