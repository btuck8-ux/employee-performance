/**
 * THE SINGLE GATED RECOMPUTE WRITE (packet 6 §1 — dry-run signed off,
 * gate released by Tucker 2026-08-26). Runs recomputePerformanceForQuarter
 * (the real writer) over:
 *
 *   - every (store, quarter) from the store's floor forward through the
 *     current quarter: jobs = stored rows ∪ active roster — exactly the
 *     signed dry-run's enumeration;
 *   - below-floor 2026 quarters: STORED ROWS ONLY, which refresh their
 *     labor metrics to null (mig 070's accepted residue — "the immediate
 *     post-deploy recompute nulls them"). No row is conjured below a
 *     floor.
 *
 * Frozen quarters are untouched (ruling 16; the writer refuses them
 * anyway). Captures before (stored attendance) and after (the writer's
 * returned metrics) per row and prints the final four-bucket table.
 *
 * Run:  node --env-file=.env.local scripts/run-gated-recompute.ts
 */

import Module from "node:module";
import { writeFileSync } from "node:fs";

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
      spec = new URL(`../src/${spec.slice(2)}`, import.meta.url).href;
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

const { createClient } = await import("@supabase/supabase-js");
const { recomputePerformanceForQuarter } = await import(
  "../src/lib/performance-recompute.ts"
);
const { fetchCustomerServiceWeights } = await import(
  "../src/lib/customer-service-score.ts"
);
const { fetchTotalImpactWeights } = await import(
  "../src/lib/total-impact-score.ts"
);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing env");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

type Quarter = 1 | 2 | 3 | 4;
const todayIso = new Date().toISOString().slice(0, 10);
const startedAt = new Date().toISOString();

const { data: locs, error: locErr } = await supabase
  .from("locations")
  .select("id, location_code, metrics_start_date")
  .order("location_code");
if (locErr || !locs) throw new Error(`locations: ${locErr?.message}`);

const { data: periods } = await supabase
  .from("report_periods")
  .select("id, year, quarter, frozen");
const frozen = new Set(
  (periods ?? []).filter((p) => p.frozen === true).map((p) => `Q${p.quarter}-${p.year}`)
);
const periodIdByLabel = new Map(
  (periods ?? []).map((p) => [`Q${p.quarter}-${p.year}`, p.id as string])
);

const curY = Number(todayIso.slice(0, 4));
const curQ = (Math.floor((Number(todayIso.slice(5, 7)) - 1) / 3) + 1) as Quarter;

interface Job {
  store: string;
  year: number;
  quarter: Quarter;
  label: string;
  employee_id: string;
  location_id: string;
  employee_code: string;
  employee_name: string;
  active: boolean;
  hadRow: boolean;
  before: number | null;
  belowFloor: boolean;
}

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const jobs: Job[] = [];

for (const loc of locs) {
  const floor = loc.metrics_start_date as string;
  const floorY = Number(floor.slice(0, 4));
  const floorQ = (Math.floor((Number(floor.slice(5, 7)) - 1) / 3) + 1) as Quarter;

  const { data: emps } = await supabase
    .from("employees")
    .select("id, employee_code, employee_name, active")
    .eq("location_id", loc.id);
  const empById = new Map((emps ?? []).map((e) => [e.id as string, e]));

  // All non-frozen 2026 quarters through the current one (ruling 16 keeps
  // 2025 out; the writer's frozen guard backstops).
  for (let y = 2026, q = 1 as Quarter; y < curY || (y === curY && q <= curQ); ) {
    const label = `Q${q}-${y}`;
    const belowFloor = y < floorY || (y === floorY && q < floorQ);
    if (!frozen.has(label)) {
      const periodId = periodIdByLabel.get(label) ?? null;
      const storedByEmployee = new Map<string, number | null>();
      if (periodId) {
        const { data: stored } = await supabase
          .from("performance_records")
          .select("employee_id, attendance_pct")
          .eq("location_id", loc.id)
          .eq("report_period_id", periodId)
          .range(0, 9999);
        for (const r of stored ?? []) {
          storedByEmployee.set(String(r.employee_id), num(r.attendance_pct));
        }
      }
      const ids = belowFloor
        ? [...storedByEmployee.keys()] // stored rows ONLY below the floor
        : [
            ...new Set([
              ...(emps ?? []).filter((e) => e.active).map((e) => e.id as string),
              ...storedByEmployee.keys(),
            ]),
          ];
      for (const id of ids) {
        const emp = empById.get(id);
        if (!emp) continue;
        jobs.push({
          store: loc.location_code as string,
          year: y,
          quarter: q,
          label,
          employee_id: id,
          location_id: loc.id as string,
          employee_code: emp.employee_code as string,
          employee_name: emp.employee_name as string,
          active: emp.active as boolean,
          hadRow: storedByEmployee.has(id),
          before: storedByEmployee.get(id) ?? null,
          belowFloor,
        });
      }
    }
    q = (q === 4 ? 1 : ((q + 1) as Quarter)) as Quarter;
    if (q === 1) y += 1;
  }
}

console.log(`jobs: ${jobs.length} (started ${startedAt})`);

// Weights are singleton config — fetch once, share across the fan-out.
const [csWeights, tisWeights] = await Promise.all([
  fetchCustomerServiceWeights(supabase),
  fetchTotalImpactWeights(supabase),
]);

interface Result extends Job {
  after: number | null;
  action: string;
  error: string | null;
}
const results: Result[] = new Array(jobs.length);
let idx = 0;
let done = 0;

async function worker() {
  for (;;) {
    const i = idx++;
    if (i >= jobs.length) return;
    const j = jobs[i];
    try {
      const r = await recomputePerformanceForQuarter(
        supabase,
        j.employee_id,
        j.location_id,
        j.year,
        j.quarter,
        { csWeights, tisWeights }
      );
      if (r.ok) {
        results[i] = {
          ...j,
          after:
            r.action === "skipped_no_activity" && !j.hadRow
              ? null
              : r.metrics.attendance_pct,
          action: r.action,
          error: null,
        };
      } else {
        results[i] = { ...j, after: null, action: "error", error: r.error };
      }
    } catch (err) {
      results[i] = {
        ...j,
        after: null,
        action: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    done += 1;
    if (done % 50 === 0) console.log(`  ${done}/${jobs.length}`);
  }
}
await Promise.all(Array.from({ length: 4 }, () => worker()));

const finishedAt = new Date().toISOString();

// ── the final table ─────────────────────────────────────────────────────────
type Bucket = "value_changed" | "null_to_value" | "value_to_null" | "unchanged" | "skipped" | "error";
function bucketOf(r: Result): Bucket {
  if (r.error) return "error";
  if (r.action === "skipped_no_activity" && !r.hadRow) return "skipped";
  const b = r.before, a = r.after;
  if (b === null && a === null) return "unchanged";
  if (b === null) return "null_to_value";
  if (a === null) return "value_to_null";
  return Math.abs(b - a) < 1e-9 ? "unchanged" : "value_changed";
}

const byStoreQuarter = new Map<string, Record<Bucket, number>>();
for (const r of results) {
  const k = `${r.store} ${r.label}`;
  const rec =
    byStoreQuarter.get(k) ??
    ({ value_changed: 0, null_to_value: 0, value_to_null: 0, unchanged: 0, skipped: 0, error: 0 } as Record<Bucket, number>);
  rec[bucketOf(r)] += 1;
  byStoreQuarter.set(k, rec);
}

console.log(`\n== FINAL WRITE TABLE (recompute ${startedAt} → ${finishedAt}) ==`);
console.log(
  ["store+period".padEnd(16), "val→val'".padStart(9), "null→val".padStart(9), "val→null".padStart(9), "unchanged".padStart(9), "skipped".padStart(8), "error".padStart(6)].join("  ")
);
for (const [k, rec] of [...byStoreQuarter.entries()].sort()) {
  console.log(
    [k.padEnd(16), String(rec.value_changed).padStart(9), String(rec.null_to_value).padStart(9), String(rec.value_to_null).padStart(9), String(rec.unchanged).padStart(9), String(rec.skipped).padStart(8), String(rec.error).padStart(6)].join("  ")
  );
}

const fmt = (v: number | null) => (v === null ? "null" : v.toFixed(2));
const errors = results.filter((r) => r.error);
const changed = results.filter((r) => bucketOf(r) === "value_changed");
const n2v = results.filter((r) => bucketOf(r) === "null_to_value");
const v2n = results.filter((r) => bucketOf(r) === "value_to_null");
const falls = changed.filter((r) => (r.after as number) < (r.before as number));

console.log(`\ntotals: changed ${changed.length} (falls ${falls.length}) · null→value ${n2v.length} · value→null ${v2n.length} · unchanged ${results.filter((r) => bucketOf(r) === "unchanged").length} · skipped ${results.filter((r) => bucketOf(r) === "skipped").length} · errors ${errors.length}`);

console.log("\n== value → different value (in full) ==");
for (const r of changed.sort((a, b) => (a.after! - a.before!) - (b.after! - b.before!))) {
  console.log(`${r.store} ${r.label} ${r.employee_code} ${r.employee_name}: ${fmt(r.before)} → ${fmt(r.after)}`);
}
console.log("\n== null → value (in full) ==");
for (const r of n2v) {
  console.log(`${r.store} ${r.label} ${r.employee_code} ${r.employee_name}: null → ${fmt(r.after)}${r.hadRow ? "" : "  [row created]"}`);
}
console.log("\n== value → null (in full) ==");
for (const r of v2n) {
  console.log(`${r.store} ${r.label} ${r.employee_code} ${r.employee_name}: ${fmt(r.before)} → null${r.belowFloor ? "  [below-floor refresh]" : ""}`);
}
if (errors.length > 0) {
  console.log("\n== ERRORS ==");
  for (const r of errors) console.log(`${r.store} ${r.label} ${r.employee_code}: ${r.error}`);
}

writeFileSync(
  "/tmp/gated-recompute-results.json",
  JSON.stringify({ startedAt, finishedAt, results }, null, 1)
);
console.log("\nresults JSON: /tmp/gated-recompute-results.json");
