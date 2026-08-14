/**
 * Contract pins for the metric-targets system (mig 051 + classifyVsTarget,
 * 2026-08-14 targets sprint).
 *
 *   (a) the migration seeds EXACTLY the nine THQ-aligned values (95 / 95 /
 *       100 / 4.75 / 4.75 / 95 / 95 / 95 / 100) — these are cross-app
 *       contract values mirrored in Training HQ; a drifted seed ships a
 *       disagreement;
 *   (b) the migration's CHECK'd key set, the canonical TARGET_METRIC_KEYS
 *       list, and (via that list's type) the TargetMetricKey union all name
 *       the same nine metrics — no key classified that can't hold a target,
 *       no target row the app never evaluates;
 *   (c) two-tier evaluation is >=-INCLUSIVE at the boundary (locked with
 *       THQ so labels never disagree) and fails null-visible on missing
 *       data or a missing target row;
 *   (d) RLS follows the 047 Class-7 pattern (all-signed-in read, SA write).
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

const { classifyVsTarget } = await import("./classify.ts");
const { TARGET_METRICS, TARGET_METRIC_KEYS } = await import(
  "./metric-targets.ts"
);

const MIGRATION_FILE = join(
  process.cwd(),
  "supabase/migrations/051_metric_targets.sql"
);
const sql = readFileSync(MIGRATION_FILE, "utf8");
const code = sql.replace(/--.*$/gm, "");

/** The nine locked (key, target) pairs (THQ memo §1, Tucker 2026-08-14). */
const LOCKED_SEEDS: Record<string, number> = {
  on_time_grace_pct: 95,
  attendance_pct: 95,
  survey_engagement_pct: 100,
  tattle_rating: 4.75,
  customer_service_rating: 4.75,
  tattle_score_food_quality: 95,
  tattle_score_accuracy: 95,
  tattle_score_speed_of_service: 95,
  avg_task_list_completion_pct: 100,
};

function parsedSeeds(): Record<string, number> {
  const m = code.match(
    /insert into public\.metric_targets\s*\(metric_key,\s*target\)\s*values\s*([\s\S]*?);/i
  );
  assert.ok(m, "seed INSERT found");
  const seeds: Record<string, number> = {};
  for (const pair of m![1].matchAll(/\('([a-z_]+)',\s*([\d.]+)\)/g)) {
    seeds[pair[1]] = Number(pair[2]);
  }
  return seeds;
}

test("migration seeds exactly the nine THQ-aligned target values", () => {
  assert.deepEqual(parsedSeeds(), LOCKED_SEEDS);
});

test("migration CHECK set == TARGET_METRIC_KEYS == the classified metric set (nine keys, both directions)", () => {
  const m = code.match(/check \(metric_key in \(([\s\S]*?)\)\)/i);
  assert.ok(m, "metric_key CHECK found");
  const checkKeys = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.equal(checkKeys.length, 9, "CHECK carries nine keys");
  assert.equal(TARGET_METRIC_KEYS.length, 9, "canonical list carries nine keys");
  // TARGET_METRIC_KEYS is typed ReadonlyArray<TargetMetricKey>, so set
  // equality here also pins the TypeScript union to the migration.
  assert.deepEqual(
    [...checkKeys].sort(),
    [...TARGET_METRIC_KEYS].sort(),
    "CHECK set and canonical key list must be identical"
  );
  // Every key is seeded and every seed is CHECK'd.
  assert.deepEqual(
    Object.keys(parsedSeeds()).sort(),
    [...checkKeys].sort(),
    "seed keys and CHECK set must be identical"
  );
});

test("TARGET_METRICS scales: ratings native 1–5, everything else 0–100", () => {
  const ratingKeys = TARGET_METRICS.filter((m) => m.scale === "rating").map(
    (m) => m.key
  );
  assert.deepEqual(
    [...ratingKeys].sort(),
    ["customer_service_rating", "tattle_rating"],
    "exactly the two rating-scale metrics"
  );
});

test("RLS: Class-7 pattern — enable + read-for-all + sa-write, plus the updated_at trigger", () => {
  assert.match(code, /alter table public\.metric_targets enable row level security/i);
  assert.match(
    code,
    /create policy metric_targets_read on public\.metric_targets\s*for select to authenticated using \(true\)/i
  );
  assert.match(
    code,
    /create policy metric_targets_sa_write on public\.metric_targets\s*for all to authenticated\s*using \(\(select public\.epd_is_system_admin\(\)\)\)\s*with check \(\(select public\.epd_is_system_admin\(\)\)\)/i
  );
  assert.match(
    code,
    /create trigger trg_metric_targets_updated\s*before update on public\.metric_targets/i
  );
});

// ---- classifyVsTarget: two-tier boundary + null discipline ----

// Evaluate against the MIGRATION's parsed seeds, so a drifted seed value
// fails the boundary pins too, not just the seed pin above.
const targets = parsedSeeds();

test(">= is inclusive: exactly-at-target is On Target (locked with THQ)", () => {
  assert.equal(classifyVsTarget("on_time_grace_pct", 95, targets), "On Target");
  assert.equal(classifyVsTarget("attendance_pct", 95, targets), "On Target");
  assert.equal(classifyVsTarget("tattle_rating", 4.75, targets), "On Target");
  assert.equal(
    classifyVsTarget("survey_engagement_pct", 100, targets),
    "On Target"
  );
  assert.equal(
    classifyVsTarget("avg_task_list_completion_pct", 100, targets),
    "On Target"
  );
});

test("just-below-target is Below Target (4.7499… != 4.75)", () => {
  assert.equal(
    classifyVsTarget("on_time_grace_pct", 94.999, targets),
    "Below Target"
  );
  assert.equal(
    classifyVsTarget("tattle_rating", 4.7499, targets),
    "Below Target"
  );
  assert.equal(
    classifyVsTarget("customer_service_rating", 4.749999, targets),
    "Below Target"
  );
  assert.equal(
    classifyVsTarget("avg_task_list_completion_pct", 99.999, targets),
    "Below Target"
  );
  assert.equal(classifyVsTarget("attendance_pct", 0, targets), "Below Target");
});

test("above-target stays On Target (no retired Exceeds tier)", () => {
  assert.equal(classifyVsTarget("on_time_grace_pct", 100, targets), "On Target");
  assert.equal(classifyVsTarget("tattle_rating", 5, targets), "On Target");
});

test("null discipline: null/undefined/NaN value → null (unclassified)", () => {
  assert.equal(classifyVsTarget("attendance_pct", null, targets), null);
  assert.equal(classifyVsTarget("attendance_pct", undefined, targets), null);
  assert.equal(classifyVsTarget("attendance_pct", NaN, targets), null);
});

test("missing target row → null (fail-visible, never a hardcoded fallback)", () => {
  assert.equal(classifyVsTarget("attendance_pct", 99, {}), null);
  assert.equal(
    classifyVsTarget("attendance_pct", 99, { attendance_pct: NaN }),
    null
  );
});
