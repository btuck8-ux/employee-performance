/**
 * Contract pins for employees.is_general_manager (mig 057, flip spec
 * 2026-08-24 §1) — TEXT-LEVEL pins per repo convention.
 *
 * Tucker's ruling: classify GMs; keep them in store-wide attendance and
 * punctuality. The flag is a display/reporting dimension ONLY — measured
 * excl-GM effects were either the Toast defect (COS/CPD GMs reading 0%) or
 * backwards (DTD/HRANCH GMs are the best attenders), so exclusion is
 * reported side-by-side, never applied. These pins hold the field to that
 * charter: SA-set only, ingest-immune, never derived, and NEVER a metric
 * input.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const migSrc = read("supabase/migrations/057_gm_classification.sql");
const editActionsSrc = read("src/app/dashboard/employees/[id]/edit/actions.ts");
const editPageSrc = read("src/app/dashboard/employees/[id]/edit/page.tsx");
const tierActionsSrc = read(
  "src/app/dashboard/admin/unclassified-tiers/actions.ts"
);

const GM_IDS = [
  "9303203e-88f2-423f-af56-b4056a6580cc", // Nick Goins, COS
  "6bf6c651-d0bf-4c5b-8bbf-d2da73ade9e3", // Luke Cato, CPD
  "f2127628-3636-407d-a0e2-dbe7c0d3e9f0", // Seth Rexroad, DTD
  "61712c3d-b8bc-4bed-9f29-35f299bdd92c", // Savannah Mallory, FCOL
  "42d4817c-77b3-4634-9715-ff591e158e78", // Taylor Garrison, FCOL (CSU)
  "eb3ae1aa-568f-4f73-b212-43d69280c636", // Jose Mena, HOU
  "0b27015d-b8c9-48da-9eaf-b7eca416177f", // Liv Sandifer, HRANCH
  "684c613b-8b94-4994-a256-bfbe2ca6110e", // Jaime Hernandez, LONGM
];

test("mig 057: boolean not null default false, guarded seeds for exactly the eight GMs", () => {
  assert.match(migSrc, /is_general_manager boolean not null default false/);
  const seeds = migSrc.match(/set is_general_manager = true/g) ?? [];
  assert.equal(seeds.length, 8, "exactly eight seed statements");
  const guards = migSrc.match(/is_general_manager is distinct from true/g) ?? [];
  assert.equal(guards.length, 8, "every seed carries the no-op/no-revert guard");
  for (const id of GM_IDS) {
    assert.match(migSrc, new RegExp(id), `missing seed for ${id}`);
  }
});

test("the flag NEVER enters a metric path — display and reporting only", () => {
  // The spec's hard pin: is_general_manager must not appear in
  // performance-recompute.ts or any scoring/combining path. Store-wide
  // side-by-side card — the ONE sanctioned metric-adjacent consumer —
  // ships with the flip PR, reading the flip's own sources
  // (seven_shifts_shifts + toast_time_entries), so the store card and the
  // employees inside it can never disagree.
  const METRIC_PATHS = [
    "src/lib/performance-recompute.ts",
    "src/lib/customer-service-score.ts",
    "src/lib/total-impact-score.ts",
    "src/lib/multi-location-metrics.ts",
    "src/lib/multi-location-fetch.ts",
  ];
  for (const p of METRIC_PATHS) {
    assert.doesNotMatch(
      read(p),
      /is_general_manager/,
      `${p} must never read is_general_manager`
    );
  }
});

test("ingest-immune: no import/upload/ingest/matcher path touches it (the wage_pay_type lesson)", () => {
  for (const p of [
    "src/app/dashboard/locations/[id]/upload-actions.ts",
    "src/lib/employee-import.ts",
    "src/app/dashboard/admin/employee-triage/actions.ts",
    "src/lib/ingest/toast/labor.ts",
    "src/lib/ingest/toast/labor-core.ts",
  ]) {
    assert.doesNotMatch(
      read(p),
      /is_general_manager/,
      `${p} must never read or write is_general_manager`
    );
  }
});

test("the tier surface writes the flag ONLY in lockstep with the tier — per store", () => {
  // The second sanctioned writer (CSU memo §6): classifying a tier IS
  // setting the flag, because the wire derives from the tier. Per-store
  // (Tucker 2026-08-26): flag = (tier == 'manager') for THAT row only,
  // with the one-GM-per-store incumbent check ahead of it.
  assert.match(tierActionsSrc, /is_general_manager: tier === "manager"/);
  assert.match(tierActionsSrc, /\.eq\("epd_role", "manager"\)\s*\n\s*\.eq\("active", true\)/);
});

test("the ONLY writer besides the migration seed is the SA employee-edit surface", () => {
  assert.match(editPageSrc, /name="is_general_manager"/);
  // Same sentinel discipline as the mig 056 marker: absent ≠ unchecked.
  assert.match(editPageSrc, /name="is_general_manager_present"/);
  // Mig 071 lockstep: the wire derives is_general_manager from epd_role,
  // so the GM toggle writes BOTH — and only on user↔manager rows (an
  // admin-tier row is never re-tiered from a checkbox).
  assert.match(editActionsSrc, /\.\.\.\(gmSubmitted && tierSyncable/);
  assert.match(
    editActionsSrc,
    /epd_role: is_general_manager \? "manager" : "user"/
  );
});

test("TRAP GUARD (Tucker 2026-08-26): the lockstep DIES with the stored column", () => {
  // The GM-toggle lockstep writes employees.is_general_manager. The column
  // is scheduled to be DROPPED in a later migration once CP + THQ confirm
  // the derived wire field. The day that drop migration lands in this
  // repo, this test fails until the lockstep (and every other stored-flag
  // write) is removed — the removal is FORCED, not remembered ("a
  // commitment that exists only in a document protects nothing").
  const migrationsDir = join(process.cwd(), "supabase/migrations");
  const dropped = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .some((f) =>
      /drop\s+column\s+(if\s+exists\s+)?is_general_manager/i.test(
        read(`supabase/migrations/${f}`)
      )
    );
  if (dropped) {
    assert.doesNotMatch(
      editActionsSrc,
      /is_general_manager/,
      "employees.is_general_manager was dropped — delete the GM-toggle lockstep and every stored-flag write from the edit surface (and retire this trap)"
    );
    assert.doesNotMatch(
      tierActionsSrc,
      /is_general_manager/,
      "employees.is_general_manager was dropped — delete the lockstep write from the tier surface too"
    );
  }
  // Never derived from title/pay type.
  assert.doesNotMatch(
    editActionsSrc,
    /is_general_manager\s*[:=][^=][^;\n]*(wage_pay_type|title|role)/,
    "must come from the form only"
  );
});

test("store-wide reporting shows BOTH ways from summed parts, on the flip's sources", () => {
  const storeAttendanceSrc = read("src/lib/store-attendance.ts");
  assert.match(storeAttendanceSrc, /allStaff/);
  assert.match(storeAttendanceSrc, /excludingManagement/);
  // The combining rule: sums of counts, rates recomputed from the sums.
  assert.match(storeAttendanceSrc, /scheduled \+= metrics\.scheduled_count/);
  assert.match(storeAttendanceSrc, /attended \+= metrics\.attended_count/);
  assert.doesNotMatch(
    storeAttendanceSrc,
    /attendance_pct\s*\+/,
    "must never sum or average per-employee percentages"
  );
  // The split's reason (Tucker 2026-08-24): Toast stores read the flip's
  // sources — pruned direct-feed schedule + Toast punches — never
  // time_entries (73.1% at CPD against an actual 97.3%). Since the flip
  // core landed (2026-08-25) the sourcing lives in flip-entries.ts — the
  // SAME layer the recompute entry points use, so the store card and the
  // employees inside it cannot disagree — and the source pins live there.
  assert.match(storeAttendanceSrc, /from "\.\/flip-entries"/);
  assert.match(storeAttendanceSrc, /fetchEffectiveEntries\(/);
  const flipSrc = read("src/lib/flip-entries.ts");
  assert.match(flipSrc, /from\("seven_shifts_shifts"\)/);
  assert.match(flipSrc, /\.is\("missing_upstream_since", null\)/);
  assert.match(flipSrc, /from\("toast_time_entries"\)/);
  // Non-punchers ride the same mig 056 effective-date gate as the recompute.
  assert.match(storeAttendanceSrc, /punchesTimeClockForPeriod\(/);
});

test("structural sweep: every src file touching the flag is on the allowlist", () => {
  const ALLOWLIST = new Set([
    "src/lib/store-attendance.ts",
    "src/lib/gm-classification-contract.test.ts",
    // 2026-08-26 §3: pins mig 067's GM exclusion in the SQL location-side
    // tip baselines — the one ruled exception to "never a metric input";
    // the TS metric paths stay unlisted and flag-free.
    "src/lib/metrics-floor.test.ts",
    "src/app/dashboard/employees/page.tsx",
    "src/app/dashboard/employees/[id]/page.tsx",
    "src/app/dashboard/employees/[id]/edit/actions.ts",
    "src/app/dashboard/employees/[id]/edit/page.tsx",
    "src/app/dashboard/admin/toast-crosswalk/data.ts",
    "src/app/dashboard/admin/toast-crosswalk/page.tsx",
    // Mig 071 (epd_role spec 2026-08-26 §4): the flag became DERIVED —
    // (epd_role = 'manager') in v_employee_identity, same wire name/type.
    // These three touch the NAME only: the two contract tests pin the
    // derivation + wire position; the identity route's doc comment states
    // it for the partner-facing contract.
    "src/lib/epd-role-contract.test.ts",
    "src/lib/identity-feed-contract.test.ts",
    "src/app/api/identity/route.ts",
    // CSU memo §6: the tier surface is the second sanctioned writer —
    // classifying a tier writes the flag in lockstep (pinned above).
    "src/app/dashboard/admin/unclassified-tiers/actions.ts",
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
    if (!readFileSync(full, "utf8").includes("is_general_manager")) continue;
    if (!ALLOWLIST.has(rel)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "unexpected files touching is_general_manager");
});
