/**
 * Contract pins for employees.punches_time_clock (mig 056, defect
 * 2026-08-24 §11) — TEXT-LEVEL pins per repo convention.
 *
 * The field exists because wage_pay_type is NOT ingest-immune (the employee
 * CSV upload writes it whenever a row carries a wage), and because deriving
 * non-puncher status from pay type or title is measured-wrong: six of seven
 * GMs punch normally, one at 42 of 42 scheduled days. These pins hold the
 * field to its charter: SA-set only, ingest-immune, never derived, and an
 * EXCLUSION from the attendance denominator rather than a zero.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const migSrc = read("supabase/migrations/056_punches_time_clock.sql");
const recomputeSrc = read("src/lib/performance-recompute.ts");
const editActionsSrc = read("src/app/dashboard/employees/[id]/edit/actions.ts");
const editPageSrc = read("src/app/dashboard/employees/[id]/edit/page.tsx");
const uploadActionsSrc = read("src/app/dashboard/locations/[id]/upload-actions.ts");
const employeeImportSrc = read("src/lib/employee-import.ts");
const triageActionsSrc = read("src/app/dashboard/admin/employee-triage/actions.ts");
const laborSrc = read("src/lib/ingest/toast/labor.ts");
const laborCoreSrc = read("src/lib/ingest/toast/labor-core.ts");

test("mig 056: boolean not null default true, seeded false for exactly one employee", () => {
  assert.match(migSrc, /punches_time_clock boolean not null default true/);
  const seeds = migSrc.match(/set punches_time_clock = false/g) ?? [];
  assert.equal(seeds.length, 1, "exactly one seed statement");
  assert.match(migSrc, /9303203e-88f2-423f-af56-b4056a6580cc/); // Nick Goins, COS
});

test("mig 056 is EFFECTIVE-DATED (flip spec §2a): since column exists and the seed carries COS's go-live", () => {
  // The marker encodes a fact that BEGAN in July 2026 — Nick Goins punched
  // ~80% for three quarters (one a THQ frozen quarter) and collapsed at
  // COS's Toast go-live. A bare boolean would null all four quarters.
  assert.match(migSrc, /punches_time_clock_since date/);
  assert.match(
    migSrc,
    /punches_time_clock_since = date '2026-07-07'/,
    "seed must carry COS's toast_sales_start_date (mig 038)"
  );
});

test("the field is INGEST-IMMUNE: no import/upload/ingest path touches it", () => {
  for (const [name, src] of [
    ["employee CSV upload", uploadActionsSrc],
    ["employee import parser", employeeImportSrc],
    ["triage mint action", triageActionsSrc],
    ["toast labor feed", laborSrc],
    ["toast labor core", laborCoreSrc],
  ] as const) {
    assert.doesNotMatch(
      src,
      /punches_time_clock/,
      `${name} must never read or write punches_time_clock`
    );
  }
});

test("the ONLY writer besides the migration seed is the SA employee-edit surface", () => {
  assert.match(editActionsSrc, /punches_time_clock/);
  assert.match(editPageSrc, /name="punches_time_clock"/);
  // Sentinel guard: an absent checkbox field must not silently flip anyone
  // to non-puncher (absent ≠ unchecked).
  assert.match(editPageSrc, /name="punches_time_clock_present"/);
  assert.match(
    editActionsSrc,
    /\.\.\.\(ptcSubmitted \? \{ punches_time_clock, punches_time_clock_since \} : \{\}\)/
  );
  // The effective date is meaningless while the employee punches — a
  // re-check must clear it, not leave a stale since behind.
  assert.match(
    editActionsSrc,
    /punches_time_clock_since = punches_time_clock \? null :/
  );
});

test("structural sweep: every src file touching the column is on the allowlist", () => {
  // Stronger than per-file pins (Codex nit 2026-08-24): any NEW code path
  // that mentions punches_time_clock must consciously join this list.
  const ALLOWLIST = new Set([
    "src/lib/performance-recompute.ts",
    "src/lib/performance-recompute.test.ts",
    "src/lib/punches-time-clock-contract.test.ts",
    "src/lib/multi-location-fetch.ts",
    // Store-wide side-by-side reporting (mig 057) applies the same
    // effective-date gate as the recompute entry points.
    "src/lib/store-attendance.ts",
    "src/app/dashboard/employees/[id]/page.tsx",
    "src/app/dashboard/employees/[id]/edit/actions.ts",
    "src/app/dashboard/employees/[id]/edit/page.tsx",
  ]);
  const root = process.cwd();
  const offenders: string[] = [];
  for (const entry of readdirSync(join(root, "src"), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    const full = join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name);
    const rel = relative(root, full);
    if (!readFileSync(full, "utf8").includes("punches_time_clock")) continue;
    if (!ALLOWLIST.has(rel)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "unexpected files touching punches_time_clock");
});

test("it is never DERIVED: no code path computes it from wage_pay_type or title", () => {
  // The edit action reads it from the form only; nothing anywhere assigns
  // it from wage_pay_type / role / title values.
  assert.doesNotMatch(
    editActionsSrc,
    /punches_time_clock\s*[:=][^=][^;\n]*wage_pay_type/,
    "must not be assigned from wage_pay_type"
  );
  assert.doesNotMatch(
    recomputeSrc,
    /wage_pay_type/,
    "the metric must key on punches_time_clock, never on pay type"
  );
  // …and never from a title/role either (6 of 7 GMs punch normally).
  for (const src of [recomputeSrc, editActionsSrc]) {
    assert.doesNotMatch(
      src,
      /punches_time_clock[^;\n]*(title|job|role|manager|gm)/i,
      "must not be derived from a title or role"
    );
  }
});

test("the attendance denominator EXCLUDES non-punchers — null, never 0", () => {
  // The pure function early-returns nulls; both DB entry points fetch the
  // marker and thread it through.
  assert.match(recomputeSrc, /punchesTimeClock\?: boolean/);
  assert.match(recomputeSrc, /opts\?\.punchesTimeClock === false/);
  const threaded = recomputeSrc.match(/scheduledScoredThrough, punchesTimeClock \}/g) ?? [];
  assert.equal(threaded.length, 2, "both computeMetricsForRange and recomputePerformanceForQuarter thread the marker");
  const fetches = recomputeSrc.match(/select\("punches_time_clock, punches_time_clock_since"\)/g) ?? [];
  assert.equal(fetches.length, 2, "both entry points fetch the marker AND its effective date");
});

test("every consumer gates through punchesTimeClockForPeriod — pre-effective-date periods stay untouched", () => {
  // Both recompute entry points, the profile summaries, and the
  // multi-location per-quarter combiner must pass the marker through the
  // effective-date gate, never raw. (A raw `!== false` fed straight into
  // computeMetricsFromEntries would null frozen pre-Toast quarters.)
  const profileSrc = read("src/app/dashboard/employees/[id]/page.tsx");
  const multiLocSrc = read("src/lib/multi-location-fetch.ts");
  const gateCalls = recomputeSrc.match(/punchesTimeClockForPeriod\(/g) ?? [];
  assert.equal(
    gateCalls.length,
    3,
    "the definition plus both entry points call the gate"
  );
  assert.match(profileSrc, /punchesTimeClockForPeriod\(/);
  assert.match(multiLocSrc, /punchesTimeClockForPeriod\(/);
  assert.match(
    multiLocSrc,
    /q\.period_end/,
    "the multi-location combiner gates per quarter, not once"
  );
});
