/**
 * Contract pins for THE FLIP's core (mig 061 + flip-entries.ts,
 * 2026-08-25) — TEXT-LEVEL pins per repo convention.
 *
 * The 2026-07-27 audit's rule: a naive actuals_source flip kills CO labor
 * because consumers read time_entries. These pins hold the flip's answer —
 * every attendance/punctuality consumer builds entries through
 * flip-entries.ts, and every remaining direct time_entries reader is on a
 * conscious allowlist with a reason.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const migSrc = read("supabase/migrations/061_actuals_source_toast.sql");
const flipSrc = read("src/lib/flip-entries.ts");
const recomputeSrc = read("src/lib/performance-recompute.ts");
const profileSrc = read("src/app/dashboard/employees/[id]/page.tsx");
const multiLocSrc = read("src/lib/multi-location-fetch.ts");
const storeSrc = read("src/lib/store-attendance.ts");

test("mig 061: exactly the seven Toast stores flip; NOLA is deliberately absent", () => {
  assert.match(migSrc, /check \(actuals_source in \('7shifts', 'cake', 'toast'\)\)/);
  assert.match(
    migSrc,
    /location_code in \('CPD', 'COS', 'DTD', 'FCOL', 'HRANCH', 'LONGM', 'HOU'\)/
  );
  assert.match(migSrc, /actuals_source is distinct from 'toast'/, "guarded seed");
  const seedBlock = migSrc.slice(migSrc.indexOf("update public.locations"));
  assert.doesNotMatch(seedBlock, /NOLA/, "NOLA never enters the seed");
  // The accepted consequences are stated loudly, not discovered later.
  assert.match(migSrc, /KITCHEN SPEED/);
  assert.match(migSrc, /HIRE-DATE FILL/);
  assert.match(migSrc, /grant select on public\.v_location_flip_config to authenticated/);
});

test("flip-entries: pruned schedule, day-conditional fallback, go-live worked split", () => {
  // Scheduled: the pruned direct feed…
  assert.match(flipSrc, /\.is\("missing_upstream_since", null\)/);
  assert.match(flipSrc, /\.eq\("deleted", false\)/);
  assert.match(flipSrc, /\.eq\("draft", false\)/);
  // …day-conditional (the method rule: the cutover depends on the
  // replacement being PRESENT for that day, never on a date alone)…
  assert.match(flipSrc, /directFeedDays\.has\(date\)/);
  // …and worked is the go-live split, mirroring v_worked_intervals.
  assert.match(flipSrc, /date >= src\.goLive/);
  // Store config rides the definer view — never a raw locations join that
  // would drop user-tier self reads (the 058 Codex blocker's lesson).
  assert.match(flipSrc, /from\("v_location_flip_config"\)/);
  assert.doesNotMatch(flipSrc, /from\("locations"\)/);
});

test("every attendance consumer builds entries through flip-entries", () => {
  // Both recompute entry points…
  const imports = recomputeSrc.match(/await import\("\.\/flip-entries"\)/g) ?? [];
  assert.equal(imports.length, 2, "computeMetricsForRange + recomputePerformanceForQuarter");
  // …the profile summaries + shift lists, the multi-location combiner, and
  // the store card.
  for (const [name, src] of [
    ["profile", profileSrc],
    ["multi-location", multiLocSrc],
    ["store card", storeSrc],
  ] as const) {
    assert.match(src, /fetchEffectiveEntries\(/, `${name} must use the flip source layer`);
  }
  // The recompute entry points fetch NO raw time_entries any more; the
  // NOLA path lives inside flip-entries.
  assert.doesNotMatch(recomputeSrc, /from\("time_entries"\)/);
});

test("reader sweep: every remaining direct time_entries reader is consciously allowlisted", () => {
  // The 2026-07-27 audit's discipline, made structural. Each entry has a
  // one-line reason; a NEW reader must join this list consciously.
  const ALLOWLIST = new Set([
    // The flip source layer itself — NOLA + pre-go-live history + the
    // day-conditional scheduled fallback.
    "src/lib/flip-entries.ts",
    // Writers: the 7shifts worked/scheduled fan-out (actuals_source-gated
    // off at Toast stores by mig 061), the CP schedule ingest (its rows
    // remain the pre-June history fallback), the time CSV upload, and the
    // CAKE imports (NOLA's actuals genuinely live here).
    "src/lib/ingest/sevenshifts/time.ts",
    "src/lib/ingest/culture-pulse/schedule-ingest.ts",
    "src/app/dashboard/locations/[id]/upload-time-actions.ts",
    "src/app/api/admin/cake-timesheet-import/route.ts",
    "src/lib/ingest/cake/ingest.ts",
    // Hire-date fill (§6-B: earliest worked time_entries row) — extending
    // it to Toast punches is a FLAGGED Tucker decision (mig 061 header),
    // not a silent change.
    "src/lib/hire-date-fill.ts",
    // 7shifts coverage guard — actuals_source-gated to 7shifts stores;
    // post-flip its loop is empty by construction, which is correct.
    "src/lib/ingest/sevenshifts/coverage.ts",
    // Operator repair/diagnostic levers over the 7shifts-era data
    // (trap-list: deliberate, not dead code) + probes, which state their
    // window/source/filter per §7.
    "src/app/api/admin/backfill-roles/route.ts",
    "src/app/api/admin/reconcile-worked-time/route.ts",
    "src/app/api/admin/reconcile-schedules/route.ts",
    "src/app/api/admin/probe-7shifts-shifts/route.ts",
    "src/app/api/admin/probe-toast-labor/route.ts",
    // Kitchen recompute keys attribution on time_entries.role — the known
    // limitation (058/061 headers); frozen for new dates at Toast stores
    // pending the jobReference→role mapping.
    "src/lib/ingest/toast/kitchen-ingest.ts",
    // /api/scores/range keeps its time_entries membership probe (history)
    // ALONGSIDE the new toast_time_entries + seven_shifts_shifts probes —
    // pinned below.
    "src/app/api/scores/range/route.ts",
    // Profile page: the non-Toast (NOLA) shift-list branch, and the TIS
    // all-time anchor which takes the EARLIEST of time_entries + Toast
    // punches (a post-flip hire's first evidence is a punch).
    "src/app/dashboard/employees/[id]/page.tsx",
    // Rankings page reads the location's EARLIEST entry_date as a
    // data-since marker — time_entries is the oldest evidence at every
    // store by construction.
    "src/app/dashboard/locations/[id]/rankings/page.tsx",
    // Likely-departed report takes the LATEST of time_entries worked +
    // Toast punches per employee — punch-only employees must not age into
    // a false departed warning.
    "src/app/dashboard/admin/users/page.tsx",
    // PDF category currency: labor data-through = latest of both worked
    // sources (dynamic maxDate table names, caught by the extended sweep).
    "src/lib/category-currency.ts",
    // CP schedule cron writes time_entries scheduled rows (the pre-June
    // history fallback's source) — a writer, named in mig 061's accepted
    // consequences.
    "src/app/api/cron/sync-cp-schedules/route.ts",
  ]);
  const root = process.cwd();
  const offenders: string[] = [];
  for (const entry of readdirSync(join(root, "src"), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue; // tests aren't readers
    const full = join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name);
    const rel = relative(root, full);
    const src = readFileSync(full, "utf8");
    // Catch direct reads, nested relationship reads (`time_entries(…)` in
    // a select string), and dynamic `.from(table)` consumers alike (Codex
    // 2026-08-25: the literal-only sweep missed all three shapes).
    if (!/"time_entries"|time_entries\(/.test(src)) continue;
    if (!ALLOWLIST.has(rel)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "unlisted time_entries consumer — classify it consciously");
});

test("attribution rides the flip: tattle/review/task/survey pools read v_worked_intervals", () => {
  // Without this, attribution freezes at the seven Toast stores on flip
  // day (no new time_entries worked rows) and tattle metrics — 0.40 of CS
  // Score — silently decay. The 2026-07-27 audit's warning, in the
  // attribution layer.
  for (const p of [
    "src/lib/ingest/tattle/ingest-location.ts",
    "src/lib/ingest/reviews/ingest-location.ts",
    "src/lib/ingest/tasks/ingest-location.ts",
    "src/app/dashboard/locations/[id]/upload-survey-actions.ts",
  ]) {
    const src = read(p);
    assert.match(src, /from\("v_worked_intervals"\)/, `${p} must read the flip's worked source`);
    assert.doesNotMatch(src, /from\("time_entries"\)/, `${p} must not read time_entries directly`);
  }
  // The crosswalk display hint scores overlap on the same pruned feed the
  // matcher uses.
  const xwalk = read("src/app/dashboard/admin/toast-crosswalk/data.ts");
  assert.match(xwalk, /from\("seven_shifts_shifts"\)/);
  assert.doesNotMatch(xwalk, /from\("time_entries"\)/);
});

test("the THQ range feed's membership probe covers the flip sources", () => {
  // A punch-only employee at a Toast store (hired post-flip) must not
  // vanish from the feed. Wire shape untouched (range-feed-contract pins).
  const src = read("src/app/api/scores/range/route.ts");
  assert.match(src, /"toast_time_entries",/);
  assert.match(src, /"seven_shifts_shifts",/);
});

// ---- Build 2 (2026-08-25): the unmapped-employee null ----------------------

test("BUILD 2: mapping presence rides the definer view — never the SA-only crosswalk table", () => {
  // toast_employee_crosswalk is SA-only (mig 055, correctly); a session
  // client reading it would see EVERYONE as unmapped and null the estate.
  // v_mapped_employees (mig 062) exposes presence only — no GUIDs.
  const flipSrc = read("src/lib/flip-entries.ts");
  assert.match(flipSrc, /from\("v_mapped_employees"\)/);
  assert.doesNotMatch(flipSrc, /from\("toast_employee_crosswalk"\)/);
  const migSrc62 = read("supabase/migrations/062_mapped_employees_view.sql");
  assert.match(migSrc62, /select distinct location_id, employee_id/);
  assert.doesNotMatch(migSrc62, /toast_employee_guid/, "presence only — no GUIDs through the view");
  assert.match(migSrc62, /grant select on public\.v_mapped_employees to authenticated/);
});

test("BUILD 2: the reverse check and the stuck state live on the crosswalk surface", () => {
  // The matcher is GUID-first; nothing asked "which scheduled employee has
  // no mapping?" — how five people read 0% with their punches queued. The
  // loud channel for the Build 2 null is this surface, not a silent null.
  const dataSrc = read("src/app/dashboard/admin/toast-crosswalk/data.ts");
  assert.match(dataSrc, /UnmappedScheduledView/);
  assert.match(dataSrc, /unmapped_scheduled/);
  // Stuck = below the auto-commit floor AND idle past the window — it can
  // never accumulate enough overlap; needs a human, not another night.
  assert.match(dataSrc, /BEHAVIOURAL_MIN_OVERLAP_DAYS/);
  assert.match(dataSrc, /STUCK_IDLE_DAYS/);
  const pageSrc = read("src/app/dashboard/admin/toast-crosswalk/page.tsx");
  assert.match(pageSrc, /Unmapped scheduled employees/);
  assert.match(pageSrc, /stuck — needs a human/);
});
