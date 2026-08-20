/**
 * Report-builder granularity pins (kickoff 2026-08-19 §3, §5 locked).
 *
 * 1. resolveIncludedMetricKeys unit behavior — all-on collapses to null
 *    (today's full PDF), partial selections expand to exact key sets.
 * 2. Key-map cross-check — every METRIC_DEFS key in EmployeeReport.tsx is
 *    governed by exactly ONE control (a metric group, the review toggle, or
 *    the tattle toggle). A new PDF row that nobody wires into the builder
 *    fails here instead of silently becoming un-excludable.
 * 3. Text pins — render-conditionally stays rendering-only, the feedback
 *    single-writer rule holds, feedback saves BEFORE generation (the
 *    stale-flag ordering §3 demands), and the §5-A consolidation doesn't
 *    quietly grow a second generation surface again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  METRIC_GROUPS,
  REVIEW_KEYS,
  TATTLE_KEYS,
  resolveIncludedMetricKeys,
} from "./report-render-options.ts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ALL_GROUP_IDS = METRIC_GROUPS.map((g) => g.id);

test("all groups + both toggles → null (no restriction, default = full PDF)", () => {
  assert.equal(resolveIncludedMetricKeys(ALL_GROUP_IDS, true, true), null);
});

test("unchecking one group drops exactly its keys", () => {
  const keys = resolveIncludedMetricKeys(
    ALL_GROUP_IDS.filter((id) => id !== "tip_rate"),
    true,
    true
  );
  assert.ok(keys !== null);
  assert.ok(!keys.includes("tip_rate_pct"));
  assert.ok(!keys.includes("tip_rate_delta_pp"));
  assert.ok(keys.includes("tip_per_hour"));
  assert.ok(keys.includes("customer_service_rating")); // reviews toggle still on
});

test("review/tattle toggles govern their rows independently of the groups", () => {
  const keys = resolveIncludedMetricKeys(ALL_GROUP_IDS, false, true);
  assert.ok(keys !== null);
  for (const k of REVIEW_KEYS) assert.ok(!keys.includes(k), `${k} excluded`);
  for (const k of TATTLE_KEYS) assert.ok(keys.includes(k), `${k} kept`);
});

test("unknown group ids are ignored, never an error", () => {
  const keys = resolveIncludedMetricKeys(["bogus"], false, false);
  assert.deepEqual(keys, []);
});

test("every EmployeeReport METRIC_DEFS key is governed by exactly one control", () => {
  const pdf = read("src/lib/pdf/EmployeeReport.tsx");
  const defsSection = pdf.slice(
    pdf.indexOf("const METRIC_DEFS"),
    pdf.indexOf("// ---- Helpers ----")
  );
  const defKeys = [...defsSection.matchAll(/key: "([a-z0-9_]+)"/g)].map((m) => m[1]);
  assert.ok(defKeys.length >= 20, `parsed ${defKeys.length} defs`);

  const governed = [
    ...METRIC_GROUPS.flatMap((g) => g.keys),
    ...REVIEW_KEYS,
    ...TATTLE_KEYS,
  ];
  const governedSet = new Set(governed);
  assert.equal(governed.length, governedSet.size, "no key governed twice");
  assert.deepEqual(
    [...governedSet].sort(),
    [...new Set(defKeys)].sort(),
    "builder controls cover exactly the PDF's metric rows"
  );
});

test("PDF filters rows/sections via render_options (render-only, §5-B)", () => {
  const pdf = read("src/lib/pdf/EmployeeReport.tsx");
  assert.match(pdf, /rowIncluded\(def\.key\)/, "metric rows gated");
  assert.match(pdf, /rowIncluded\("customer_service_score"\)/, "CS breakdown gated");
  assert.match(pdf, /showFeedback &&/, "feedback section gated");
});

test("manager_feedback single-writer rule: only src/lib/manager-feedback.ts updates the column", () => {
  const writer = read("src/lib/manager-feedback.ts");
  assert.match(writer, /update\(\{ manager_feedback: text \}\)/);
  for (const p of [
    "src/app/dashboard/employees/[id]/manager-feedback-actions.ts",
    "src/app/dashboard/reports/builder-actions.ts",
  ]) {
    const src = read(p);
    assert.match(src, /from "@\/lib\/manager-feedback"/, `${p} uses the shared writer`);
    // A direct column write looks like `{ manager_feedback: ... }`; the
    // [^_] guard keeps the legit include_manager_feedback option out of it.
    assert.doesNotMatch(src, /[^_]manager_feedback:\s/, `${p} has no direct column write`);
  }
});

test("builder saves feedback BEFORE generating (fresh report is never stale)", () => {
  const src = read("src/app/dashboard/reports/builder-actions.ts");
  const save = src.indexOf("writeManagerFeedback(");
  const generate = src.indexOf("renderAndStorePerformanceReport(supabase");
  assert.ok(save !== -1 && generate !== -1);
  assert.ok(save < generate, "feedback write precedes the quarterly generation loop");
});

test("§5-A consolidation: the profile row links to the builder, no second surface", () => {
  const tabs = read("src/components/employee/PerformanceHistoryTabs.tsx");
  assert.match(tabs, /builder_employee=/, "row links into the builder pre-filled");
  // Prop/argument syntax only — the §5-A comment may mention the old name.
  assert.doesNotMatch(tabs, /generateAction[:=]/, "row-level performance generateAction is retired");
  const gen = read("src/app/dashboard/employees/[id]/generate-report-actions.ts");
  assert.doesNotMatch(gen, /export async function generatePerformanceReportAction/);
});
