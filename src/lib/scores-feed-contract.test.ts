/**
 * Wire-contract pin for the scores feed (GET /api/scores).
 *
 * The route serves `select("*")` straight off `v_employee_scores(_latest)`, so
 * the wire shape IS the view shape. Two live consumers (Culture Pulse 09:00
 * UTC, Training HQ 11:15 UTC) parse it in production. These tests pin the
 * contract at its source — the latest view-replacing migration (048):
 *
 *   (a) 26 columns in locked order: the original 11, the 9 metrics (mig 045),
 *       the 6 per-metric counts (mig 048) — always appended, never reordered;
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
  "supabase/migrations/048_v_employee_scores_count_fields.sql"
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
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/--.*$/, "").trim();
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
      const bare = line.match(/^([a-z_]+),?$/i);
      if (bare) cols.push(bare[1]);
    }
  }
  return cols;
}

for (const view of ["v_employee_scores", "v_employee_scores_latest"]) {
  test(`${view}: 26-column shape — 11 original + 9 metrics + 6 counts, in order`, () => {
    const cols = outputColumns(viewStatement(view));
    assert.deepEqual(cols, [...ORIGINAL_11, ...NEW_9, ...COUNTS_6]);
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
  assert.doesNotMatch(code, /coalesce|nullif/i, "no null-rewriting anywhere in the view");
});

test("v_employee_scores_latest: each metric and count is a bare column pass-through (null stays null)", () => {
  const stmt = viewStatement("v_employee_scores_latest");
  const lines = stmt
    .split("\n")
    .map((l) => l.replace(/--.*$/, "").trim().replace(/,$/, ""));
  for (const col of [...NEW_9, ...COUNTS_6]) {
    assert.ok(
      lines.includes(col),
      `${col} must be selected as a bare identifier — no coalesce/nullif/expressions`
    );
  }
  const code = stmt.replace(/--.*$/gm, "");
  assert.doesNotMatch(code, /coalesce|nullif/i, "no null-rewriting anywhere in the view");
});

test("v_employee_scores: security_invoker and active-employee filter survive", () => {
  const stmt = viewStatement("v_employee_scores");
  assert.match(stmt, /security_invoker = true/);
  assert.match(stmt, /where e\.active/);
});

test("v_employee_scores_latest: DISTINCT ON latest-period semantics survive", () => {
  const stmt = viewStatement("v_employee_scores_latest");
  assert.match(stmt, /security_invoker = true/);
  assert.match(stmt, /distinct on \(employee_code, location_code\)/i);
  assert.match(stmt, /order by employee_code, location_code, period_start desc/i);
});

// ---------------------------------------------------------------------------
// §1d (demarcation packet 2026-08-26): THE FEED IS DELIBERATELY NOT GATED
// by the metrics_start_date floor. Training HQ holds value-only fingerprints
// on the frozen quarters — Q3 2025 = 160 rows / Q4 2025 = 178 — and both
// quarters sit entirely below every store's floor. Gating the feed would
// delete both fingerprints overnight and void the frozen-quarter
// arrangement; gating only scoring + UI leaves those rows stored and
// served. This is the whole reason the floor was chosen over a delete.
// The live counterpart of this pin: after any floor-adjacent deploy, assert
// /api/scores serves exactly 160 Q3-2025 and 178 Q4-2025 rows.
// ---------------------------------------------------------------------------

test("§1d: the demarcation floor never leaks into the scores feed — route and views are floor-blind", () => {
  const routeSrc = readFileSync(
    join(process.cwd(), "src/app/api/scores/route.ts"),
    "utf8"
  );
  const rangeRouteSrc = readFileSync(
    join(process.cwd(), "src/app/api/scores/range/route.ts"),
    "utf8"
  );
  for (const [name, src] of [
    ["scores route", routeSrc],
    ["scores/range route", rangeRouteSrc],
    ["scores views migration", sql],
  ] as const) {
    assert.ok(
      !src.includes("metrics_start"),
      `${name} must not reference the floor — feeds serve stored history unchanged`
    );
  }
  // The range feed computes live through computeMetricsForRange (whose
  // labor window self-clamps) but its 18-field wire must not grow the
  // disclosure fields without THQ coordination.
  assert.ok(
    !rangeRouteSrc.includes("labor_window"),
    "labor_window_* are internal fields — a wire addition is a cross-project contract change"
  );
});
