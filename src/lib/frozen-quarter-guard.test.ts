/**
 * The frozen-quarter guard + no-conjuring rule (frozen-quarter spec
 * 2026-08-25 §1–§3).
 *
 * Three layers, matching the spec's §1c pins:
 *  1. BEHAVIORAL — recomputePerformanceForQuarter refuses a frozen period
 *     and WRITES NOTHING (the fake supabase throws on any table or RPC
 *     beyond the report_periods read, so success proves untouched — not
 *     merely that the call failed).
 *  2. PURE — frozenQuarterRefusal decision table (override naming the exact
 *     quarter succeeds; the wrong quarter is refused; a non-frozen period
 *     is unaffected) and periodHasActivity (§3).
 *  3. TEXT-LEVEL contract pins per repo convention: the guard lives in the
 *     asset and precedes the upsert; every reporting surface separates
 *     created / updated / skipped; the backfill's entry-date bound feeds
 *     the recompute quarter set; mig 063 seeds Q3/Q4 2025.
 *
 * Module loading: same registerHooks shim as performance-recompute.test.ts
 * (`@/…` alias + extensionless relative imports under bare type-stripping).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Module from "node:module";

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
  frozenQuarterRefusal,
  periodHasActivity,
  recomputePerformanceForQuarter,
  FROZEN_REFUSAL_PREFIX,
} = await import("./performance-recompute.ts");

// ---------------------------------------------------------------------------
// 1. Behavioral: a frozen period without an override is refused BEFORE any
//    write. The fake client throws on everything except the report_periods
//    read, so a passing test proves nothing else was even looked at.
// ---------------------------------------------------------------------------

function frozenPeriodFake() {
  const tablesTouched: string[] = [];
  const client = {
    from(table: string) {
      tablesTouched.push(table);
      if (table !== "report_periods") {
        throw new Error(`unexpected table access during refusal: ${table}`);
      }
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({
          data: { id: "period-frozen-1", frozen: true },
          error: null,
        }),
      };
      return chain;
    },
    rpc(name: string) {
      throw new Error(`unexpected rpc during refusal: ${name}`);
    },
  };
  return { client, tablesTouched };
}

test("a recompute targeting a frozen period without an override returns ok:false and writes nothing", async () => {
  const { client, tablesTouched } = frozenPeriodFake();
  const result = await recomputePerformanceForQuarter(
    // Minimal fake — the refusal path must never reach past report_periods.
    client as never,
    "emp-1",
    "loc-1",
    2025,
    4
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.startsWith(FROZEN_REFUSAL_PREFIX));
  assert.ok(
    !result.ok && result.error.includes('allowFrozenQuarter: "Q4-2025"'),
    "the refusal must name the exact override required"
  );
  // The row is untouched — not merely "the call failed": the only table the
  // function was allowed to see is the period lookup itself.
  assert.deepEqual(tablesTouched, ["report_periods"]);
});

test("an override naming the WRONG quarter is refused, and still writes nothing", async () => {
  const { client, tablesTouched } = frozenPeriodFake();
  const result = await recomputePerformanceForQuarter(
    client as never,
    "emp-1",
    "loc-1",
    2025,
    4,
    // A caller that has no idea which quarter it is about to touch — the
    // boolean-override failure mode the spec forbids.
    { allowFrozenQuarter: "Q3-2025" }
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /names "Q3-2025", not this quarter/.test(result.error));
  assert.deepEqual(tablesTouched, ["report_periods"]);
});

// ---------------------------------------------------------------------------
// 2. Pure decision table.
// ---------------------------------------------------------------------------

test("frozenQuarterRefusal: the correctly-named override succeeds", () => {
  assert.equal(frozenQuarterRefusal(true, 2025, 4, "Q4-2025"), null);
  assert.equal(frozenQuarterRefusal(true, 2025, 3, "Q3-2025"), null);
});

test("frozenQuarterRefusal: a non-frozen period is unaffected, override or not", () => {
  assert.equal(frozenQuarterRefusal(false, 2025, 4, undefined), null);
  assert.equal(frozenQuarterRefusal(false, 2026, 2, "Q2-2026"), null);
});

test("frozenQuarterRefusal: exact-label matching — near-misses are refusals", () => {
  // Wrong quarter, wrong casing, wrong order, boolean-ish junk: all refused.
  for (const bad of ["Q3-2025", "q4-2025", "2025-Q4", "Q4 2025", "true", ""]) {
    assert.notEqual(
      frozenQuarterRefusal(true, 2025, 4, bad),
      null,
      `override "${bad}" must not unlock Q4-2025`
    );
  }
  assert.notEqual(frozenQuarterRefusal(true, 2025, 4, undefined), null);
});

test("periodHasActivity (§3): no signal at all = no row conjured; any single signal = write allowed", () => {
  const quiet = {
    entry_count: 0,
    tattle_quantity: 0,
    customer_review_quantity: 0,
    surveys_assigned: 0,
    tasks_accountable: 0,
    tasks_owned: 0,
    hours_worked: null,
    kitchen_items: null,
  };
  assert.equal(periodHasActivity(quiet), false);
  // Zero-but-present numerics are still "no activity" — null vs 0 must not
  // change the decision here.
  assert.equal(periodHasActivity({ ...quiet, hours_worked: 0, kitchen_items: 0 }), false);
  for (const overlay of [
    { entry_count: 1 },
    { tattle_quantity: 1 },
    { customer_review_quantity: 1 },
    { surveys_assigned: 1 },
    { tasks_accountable: 1 },
    { tasks_owned: 1 },
    { hours_worked: 0.25 },
    { kitchen_items: 3 },
  ]) {
    assert.equal(
      periodHasActivity({ ...quiet, ...overlay }),
      true,
      `${Object.keys(overlay)[0]} alone must count as activity`
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Text-level contract pins (repo convention).
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const recomputeSrc = read("src/lib/performance-recompute.ts");
const jobsSrc = read("src/lib/ingest/sevenshifts/recompute.ts");
const timeSrc = read("src/lib/ingest/sevenshifts/time.ts");
const backfillSrc = read("src/app/api/admin/backfill-worked-time/route.ts");
const leverSrc = read("src/app/api/admin/recompute-quarter/route.ts");
const scoringSrc = read("src/app/dashboard/admin/scoring/actions.ts");
const migrationSrc = read("supabase/migrations/063_report_periods_frozen.sql");

test("the guard lives in the ASSET: refusal precedes both the period-create RPC and the upsert", () => {
  const fn = recomputeSrc.indexOf("export async function recomputePerformanceForQuarter");
  assert.ok(fn > 0);
  const frozenRead = recomputeSrc.indexOf('select("id, frozen")', fn);
  const refusal = recomputeSrc.indexOf("frozenQuarterRefusal(", fn);
  const periodCreate = recomputeSrc.indexOf('rpc("upsert_quarter"', fn);
  const upsert = recomputeSrc.indexOf('from("performance_records")', fn);
  assert.ok(frozenRead > 0, "the period lookup must read the frozen flag");
  assert.ok(refusal > 0 && refusal < periodCreate, "guard precedes the period-create RPC");
  assert.ok(refusal < upsert, "guard precedes any performance_records access");
  // Refuse, don't throw — runRecomputeJobs collects failures per job.
  assert.match(recomputeSrc, /if \(refusal\) return \{ ok: false, error: refusal \}/);
});

test("frozen-ness comes from report_periods.frozen — no hardcoded year comparison anywhere on the write paths", () => {
  for (const [name, src] of [
    ["performance-recompute", recomputeSrc],
    ["recompute jobs", jobsSrc],
    ["lever route", leverSrc],
    ["scoring actions", scoringSrc],
  ] as const) {
    assert.doesNotMatch(src, /year\s*[<>]=?\s*20\d\d/, `${name} must not hardcode frozen-ness as a date`);
  }
});

test("mig 063: frozen column exists, defaults false, and seeds exactly Q3+Q4 2025", () => {
  assert.match(migrationSrc, /add column if not exists frozen boolean not null default false/);
  assert.match(migrationSrc, /upsert_quarter\(2025, 3\)/);
  assert.match(migrationSrc, /upsert_quarter\(2025, 4\)/);
  assert.match(migrationSrc, /year = 2025/);
  assert.match(migrationSrc, /quarter in \(3, 4\)/);
});

test("runRecomputeJobs threads allowFrozenQuarter and reports created/updated/skipped separately", () => {
  assert.match(jobsSrc, /allowFrozenQuarter\?: string/);
  assert.match(jobsSrc, /allowFrozenQuarter: opts\?\.allowFrozenQuarter/);
  for (const field of ["created", "updated", "skipped_no_activity"]) {
    assert.match(jobsSrc, new RegExp(`${field}: number`), `RecomputeResult carries ${field}`);
  }
});

test("no-conjuring (§3): existence + activity checked before the upsert; an existing row still updates", () => {
  const fn = recomputeSrc.indexOf("export async function recomputePerformanceForQuarter");
  const existence = recomputeSrc.indexOf("existingRow", fn);
  const activity = recomputeSrc.indexOf("periodHasActivity(", fn);
  const upsert = recomputeSrc.indexOf(".upsert(", fn);
  assert.ok(existence > 0 && existence < upsert, "existence check precedes the upsert");
  assert.ok(activity > 0 && activity < upsert, "activity check precedes the upsert");
  assert.match(recomputeSrc, /skipped_no_activity/);
  // Only a MISSING row skips — !existingRow gates the skip, so a quiet
  // employee's existing row refreshes to null instead of going stale.
  assert.match(recomputeSrc, /!existingRow &&\s*\n\s*!periodHasActivity/);
});

test("the lever reports created vs updated vs skipped — 'employees touched' concealed both incidents", () => {
  for (const field of ["records_created", "records_updated", "records_skipped_no_activity"]) {
    assert.match(leverSrc, new RegExp(field), `lever write response carries ${field}`);
  }
});

test("backfill-worked-time (§2): entry-date bound is a distinct axis from the modification window", () => {
  assert.match(backfillSrc, /entry_from/);
  assert.match(backfillSrc, /entry_to/);
  assert.match(backfillSrc, /entryWindow/);
  // Both windows in the response — the incident run reported only the fetch
  // window, which is why nothing looked wrong at the time.
  assert.match(backfillSrc, /modification_window_fetched/);
  assert.match(backfillSrc, /entry_window_written/);
  // since= keeps its fetch-window meaning.
  assert.match(backfillSrc, /modified_since/);
});

test("the recompute quarter set derives from the BOUNDED entries, never the raw fetch", () => {
  const boundedDef = timeSrc.indexOf("const boundedEntries");
  const quarterSet = timeSrc.indexOf("distinctQuarters(boundedEntries");
  const upsertBuild = timeSrc.indexOf("boundedEntries.map((c) =>");
  assert.ok(boundedDef > 0, "time.ts filters collapsed entries by entry date");
  assert.ok(quarterSet > boundedDef, "quarter set derives from bounded entries");
  assert.ok(upsertBuild > boundedDef, "upsert payloads derive from bounded entries");
  assert.doesNotMatch(timeSrc, /distinctQuarters\(collapse\.entries/);
  assert.match(timeSrc, /entries_outside_entry_window/);
});

test("the scoring global recompute surfaces frozen skips instead of swallowing them", () => {
  assert.match(scoringSrc, /FROZEN_REFUSAL_PREFIX/);
  assert.match(scoringSrc, /frozen_skipped/);
  assert.match(scoringSrc, /tis_frozen_skipped/);
});
