/**
 * Wire-contract pin for the scores feed (GET /api/scores).
 *
 * The route serves `select("*")` straight off `v_employee_scores(_latest)`, so
 * the wire shape IS the view shape. Two live consumers (Culture Pulse 09:00
 * UTC, Training HQ 11:15 UTC) parse it in production. These tests pin the
 * contract at its source — the latest view-replacing migration (069):
 *
 *   (a) 28 columns in locked order: the original 11, the 9 metrics (mig 045),
 *       the 6 per-metric counts (mig 048), the 2 effective-window fields
 *       (mig 069, §2b — THQ contract) — always appended, never reordered;
 *   (b) every metric and count is a straight `pr.<col> as <col>` pass-through
 *       — no coalesce/nullif, so SQL null (not-computed) reaches the wire as
 *       JSON null, never 0 (317 real surveys_completed=0 rows depend on the
 *       distinction);
 *   (c) the pre-existing fields are unchanged in name and order.
 *
 * If a future migration replaces these views, point MIGRATION_FILE at it —
 * the assertions are the contract, the filename is incidental.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_FILE = join(
  process.cwd(),
  "supabase/migrations/069_scores_feed_effective_window.sql"
);

/** The 11 columns both live consumers already parse — order matters. */
const ORIGINAL_11 = [
  "employee_code",
  "employee_email",
  "location_code",
  "period_label",
  "period_start",
  "period_end",
  "customer_service_score",
  "total_impact_score",
  "cs_components_count",
  "tis_components_count",
  "computed_at",
];

/** The 9 metrics (Tucker 2026-08-10): wire names = performance_records columns. */
const NEW_9 = [
  "on_time_grace_pct",
  "attendance_pct",
  "survey_engagement_pct",
  "customer_service_rating",
  "tattle_rating",
  "tattle_score_food_quality",
  "tattle_score_accuracy",
  "tattle_score_speed_of_service",
  "avg_task_list_completion_pct",
];

/** The 6 count fields (THQ memo 2026-08-12, FINAL): order is contract. */
const COUNTS_6 = [
  "surveys_assigned",
  "surveys_completed",
  "customer_review_quantity",
  "tattle_quantity",
  "tasks_accountable",
  "tasks_completed",
];

/** The 2 effective-window fields (THQ contract 2026-08-26, §2b): 26 → 28,
 * appended, present on EVERY row — absence is never the encoding for "no
 * clamp applied". data_start_date null = no floor (NOLA), never epoch/today. */
const WINDOW_2 = ["data_start_date", "effective_period_start"];

const sql = readFileSync(MIGRATION_FILE, "utf8");

/** Split the migration into one statement per `create or replace view`. */
function viewStatement(viewName: string): string {
  const statements = sql.split(/;\s*(?=create or replace view|$)/i);
  const stmt = statements.find((s) =>
    s.match(new RegExp(`create or replace view\\s+public\\.${viewName}\\b`, "i"))
  );
  assert.ok(stmt, `migration defines public.${viewName}`);
  return stmt;
}

/**
 * Output column names of a view statement, in order. Handles the two shapes
 * this migration uses: `expr as name` lines and bare `name,` lines.
 */
function outputColumns(stmt: string): string[] {
  const body = stmt.slice(stmt.search(/\bselect\b/i));
  const cols: string[] = [];
  let depth = 0; // inside a multi-line expression (069's greatest(...))
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/--.*$/, "").trim();
    if (depth > 0) {
      depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
      // the closing line may carry the alias
      const closing = line.match(/\bas\s+([a-z_]+),?$/i);
      if (depth <= 0 && closing) cols.push(closing[1]);
      continue;
    }
    if (!line || /^select\b/i.test(line) || /^distinct\b/i.test(line)) {
      // `select distinct on (...) first_col` puts the first column on the
      // select line itself; capture a trailing bare identifier if present.
      const trailing = line.match(/\)\s*([a-z_]+),?$/i);
      if (trailing) cols.push(trailing[1]);
      continue;
    }
    if (/^(from|join|where|order)\b/i.test(line)) break;
    const aliased = line.match(/\bas\s+([a-z_]+),?$/i);
    if (aliased) {
      cols.push(aliased[1]);
    } else {
      // Bare identifiers, optionally source-qualified (069's latest view
      // reads s.<col> from the history view).
      const bare = line.match(/^(?:[a-z_]+\.)?([a-z_]+),?$/i);
      if (bare) cols.push(bare[1]);
      else {
        depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
      }
    }
  }
  return cols;
}

for (const view of ["v_employee_scores", "v_employee_scores_latest"]) {
  test(`${view}: 28-column shape — 11 original + 9 metrics + 6 counts + 2 window fields, in order`, () => {
    const cols = outputColumns(viewStatement(view));
    assert.deepEqual(cols, [...ORIGINAL_11, ...NEW_9, ...COUNTS_6, ...WINDOW_2]);
    assert.equal(cols.length, 28, "key count rises by exactly two (§2b)");
  });
}

test("v_employee_scores: each metric and count is a straight pass-through (null stays null)", () => {
  const stmt = viewStatement("v_employee_scores");
  for (const col of [...NEW_9, ...COUNTS_6]) {
    const line = stmt
      .split("\n")
      .map((l) => l.replace(/--.*$/, "").trim().replace(/,$/, "").replace(/\s+/g, " "))
      .find((l) => l.endsWith(`as ${col}`));
    assert.ok(line, `${col} selected`);
    assert.equal(
      line,
      `pr.${col} as ${col}`,
      `${col} must be a bare pr.* pass-through — no coalesce/nullif/casts`
    );
  }
  const code = stmt.replace(/--.*$/gm, "");
  const passThroughRegion = code.slice(0, code.indexOf("as tasks_completed"));
  assert.doesNotMatch(
    passThroughRegion,
    /coalesce|nullif/i,
    "no null-rewriting on any metric/count column (the §2b effective_period_start expression sits after them and is the one sanctioned coalesce)"
  );
});

test("v_employee_scores_latest: each metric and count is a bare column pass-through (null stays null)", () => {
  const stmt = viewStatement("v_employee_scores_latest");
  const lines = stmt
    .split("\n")
    .map((l) =>
      l.replace(/--.*$/, "").trim().replace(/,$/, "").replace(/^s\./, "")
    );
  for (const col of [...NEW_9, ...COUNTS_6, ...WINDOW_2]) {
    assert.ok(
      lines.includes(col),
      `${col} must be selected as a bare identifier — no coalesce/nullif/expressions`
    );
  }
  const code = stmt.replace(/--.*$/gm, "");
  assert.doesNotMatch(code, /coalesce|nullif/i, "no null-rewriting anywhere in the view");
});

test("§1d restoration (069): the HISTORY view serves every stored row — no active filter", () => {
  // Measured 2026-08-26: the 08-26 archiving of 40+ departed employees
  // silently removed 72 frozen-quarter rows from the wire (160/178 stored,
  // 125/141 served) while THQ held value fingerprints on exactly those
  // rows. History belongs to the period, not to current employment.
  const stmt = viewStatement("v_employee_scores");
  assert.match(stmt, /security_invoker = true/);
  const code = stmt.replace(/--.*$/gm, "");
  assert.doesNotMatch(
    code,
    /where\s+e\.active/i,
    "the history view must never filter on employment status"
  );
});

test("v_employee_scores_latest: DISTINCT ON latest semantics survive; ACTIVE-ONLY lives here now", () => {
  const stmt = viewStatement("v_employee_scores_latest");
  assert.match(stmt, /security_invoker = true/);
  assert.match(stmt, /distinct on \(s\.employee_code, s\.location_code\)/i);
  assert.match(stmt, /order by s\.employee_code, s\.location_code, s\.period_start desc/i);
  // The current-state view keeps CP's daily pull population-identical to
  // the pre-archiving wire: active staff only.
  assert.match(stmt, /where e\.active/);
});

// ---------------------------------------------------------------------------
// §1d (demarcation packet 2026-08-26): THE FEED IS DELIBERATELY NOT GATED
// by the metrics_start_date floor. Training HQ holds value-only fingerprints
// on the frozen quarters — both sit entirely below every store's floor.
// Gating the feed would void the frozen-quarter arrangement; gating only
// scoring + UI leaves those rows stored and served. This is the whole
// reason the floor was chosen over a delete.
//
// §1d-i (THQ amendment, ACCEPTED): the live pin HASHES VALUES, never
// counts rows — a recompute that nulls every value leaves the count at
// exactly 160/178 while the quarter is gone ("a count cannot guard a
// value"). THQ's fingerprints, computed_at stripped:
//   Q3 2025 = 160 rows / 325ce90aaf78d11ef72cdaeedcc2cc64
//   Q4 2025 = 178 rows / 9ed90951d45c28657c96c8efb290ade2
// via md5(string_agg(employee_code || '|' || (row - 'computed_at')::text,
// E'\n' order by employee_code)) over the served payload. Run after every
// floor-adjacent or view-touching deploy.
//
// §1d-ii — the stronger guarantee sits in FRONT of the pin: both periods
// are frozen (mig 063) and recomputePerformanceForQuarter refuses any
// frozen-period recompute absent an exact named override. The floor is
// never consulted there; the guard fires first.
// ---------------------------------------------------------------------------

test("§1d: the floor never FILTERS the feed — data_start_date is disclosure metadata, not a gate", () => {
  const routeSrc = readFileSync(
    join(process.cwd(), "src/app/api/scores/route.ts"),
    "utf8"
  );
  const rangeRouteSrc = readFileSync(
    join(process.cwd(), "src/app/api/scores/range/route.ts"),
    "utf8"
  );
  // The routes stay floor-blind entirely.
  for (const [name, src] of [
    ["scores route", routeSrc],
    ["scores/range route", rangeRouteSrc],
  ] as const) {
    assert.ok(
      !src.includes("metrics_start"),
      `${name} must not reference the floor — feeds serve stored history unchanged`
    );
  }
  // The views expose the floor ONLY as the two §2b metadata columns —
  // never in a predicate. No WHERE/JOIN condition may consult it.
  for (const view of ["v_employee_scores", "v_employee_scores_latest"]) {
    const code = viewStatement(view).replace(/--.*$/gm, "");
    const whereAt = code.search(/\bwhere\b/i);
    const whereClause = whereAt >= 0 ? code.slice(whereAt) : "";
    assert.ok(
      !/metrics_start/.test(whereClause),
      `${view}: metrics_start_date must never appear in a predicate`
    );
  }
  // The range feed's 18-field wire must not grow the internal disclosure
  // fields without THQ coordination (the §2b keys live on /api/scores).
  assert.ok(
    !rangeRouteSrc.includes("labor_window"),
    "labor_window_* are internal fields — a wire addition is a cross-project contract change"
  );
});
