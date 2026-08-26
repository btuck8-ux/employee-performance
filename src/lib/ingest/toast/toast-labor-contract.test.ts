/**
 * Contract pins for the Toast Labor feed (workstream I, rulings 2026-08-23)
 * — TEXT-LEVEL pins per repo convention. These are the tests the ruling
 * names: the time_entries fence, the GUID allow-list, the identity anchor,
 * the name-matching prohibition, and the endpoint facts the probe measured.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const laborSrc = read("src/lib/ingest/toast/labor.ts");
const coreSrc = read("src/lib/ingest/toast/labor-core.ts");
const cronSrc = read("src/app/api/cron/sync-toast-labor/route.ts");
const backfillSrc = read("src/app/api/admin/backfill-toast-labor/route.ts");
const reconcileSrc = read("src/app/api/admin/reconcile-worked-time/route.ts");
const restampSrc = read("src/app/api/admin/restamp-toast-attributions/route.ts");
const actionsSrc = read("src/app/dashboard/admin/toast-crosswalk/actions.ts");
const migSrc = read("supabase/migrations/055_toast_labor_feed.sql");
const vercelJson = read("vercel.json");

const ALL_FEED_SOURCES = [
  ["labor.ts", laborSrc],
  ["labor-core.ts", coreSrc],
  ["sync-toast-labor route", cronSrc],
  ["backfill route", backfillSrc],
  ["reconcile route", reconcileSrc],
  ["restamp route", restampSrc],
  ["crosswalk actions", actionsSrc],
] as const;

test("the Toast feed NEVER writes time_entries — reads only (§2.4 collision guard)", () => {
  // This is the pin that stops a later refactor reintroducing the H3-shaped
  // conflict: sevenshifts/time.ts owns entry_type='worked' on time_entries'
  // unique key. Every .from("time_entries") in the feed must be a .select.
  for (const [name, src] of ALL_FEED_SOURCES) {
    const parts = src.split('.from("time_entries")');
    for (let i = 1; i < parts.length; i++) {
      const next = parts[i].slice(0, 60).replace(/\s/g, "");
      assert.ok(
        next.startsWith(".select("),
        `${name}: time_entries access #${i} must be a read, saw: ${next.slice(0, 30)}`
      );
    }
  }
});

test("no module in the feed touches actuals_source (the 'kills CO labor' flip)", () => {
  // Quoted/keyed forms only — code selecting, filtering, or writing the
  // column; the doc comments naming the trap mention it in prose.
  for (const [name, src] of ALL_FEED_SOURCES) {
    assert.doesNotMatch(
      src,
      /"actuals_source"|actuals_source:/,
      `${name} must not touch actuals_source`
    );
  }
});

test("endpoint paths pin to what the probe measured", () => {
  assert.match(laborSrc, /\/labor\/v1\/timeEntries/);
  assert.match(laborSrc, /\/labor\/v1\/employees/);
  // The 30-day cap is real (400 code 10000) — the chunker must stay ≤30.
  assert.match(coreSrc, /maxDays = 28/);
});

test("store scoping is the GUID allow-list — never 'all the credential reaches'", () => {
  // The credential also reaches Chico CA and a stray second Fort Collins.
  assert.match(laborSrc, /\.not\("toast_restaurant_guid", "is", null\)/);
  // No discovery endpoint that would enumerate the credential's restaurants.
  for (const [name, src] of ALL_FEED_SOURCES) {
    assert.doesNotMatch(src, /\/restaurants\/v[0-9]/, `${name} must not enumerate restaurants`);
  }
});

test("identity anchors on employees.id — never through seven_shifts_user_id (§1a)", () => {
  assert.match(migSrc, /employee_id\s+uuid not null references public\.employees\(id\)/);
  for (const [name, src] of [
    ["labor.ts", laborSrc],
    ["labor-core.ts", coreSrc],
    ["crosswalk actions", actionsSrc],
  ] as const) {
    // Quoted form only — the column reference code would use; the doc
    // comments that STATE the prohibition mention the bare name.
    assert.doesNotMatch(
      src,
      /"seven_shifts_user_id"/,
      `${name}: the Toast crosswalk must not route through a 7shifts id`
    );
  }
});

test("NAME MATCHING IS FORBIDDEN in the matching modules (hint-only in the UI)", () => {
  // Ryan Griffin ≠ Connor Griffin; Amy Roberts ≠ Amy Segelhorst. The
  // matcher and the actions may never read a name field; the page/data
  // layer shows names as display hints only.
  for (const [name, src] of [
    ["labor.ts", laborSrc],
    ["labor-core.ts", coreSrc],
    ["crosswalk actions", actionsSrc],
  ] as const) {
    assert.doesNotMatch(src, /employee_name/, `${name} must not read employee_name`);
    assert.doesNotMatch(src, /firstName|lastName|chosenName/, `${name} must not read Toast name fields`);
  }
});

test("identity resolution: match_method is the closed email|auto_behavioural|manual set", () => {
  assert.match(
    migSrc,
    /match_method in \('email', 'auto_behavioural', 'manual'\)/
  );
  assert.match(laborSrc, /match_method: "email"/);
  assert.match(laborSrc, /match_method: "auto_behavioural"/);
  assert.match(actionsSrc, /match_method: "manual"/);
});

test("auto-commits store their evidence and the unmatched path survives (never guessed)", () => {
  assert.match(laborSrc, /evidence: \{/);
  assert.match(laborSrc, /best_overlap_days/);
  // Unmatched punches are STORED with employee_id null, not dropped.
  assert.match(coreSrc, /employee_id: employeeId/);
  assert.match(coreSrc, /unmatchedPunchDates/);
});

test("§5b time evidence is required, ranked on, and stored (defect 2026-08-24)", () => {
  // Ceiling + margin live in labor-core (pinned at 60/15 by its unit
  // tests); every auto row's evidence carries the medians and §5d's pool
  // visibility so a null runner-up is distinguishable from a walkover.
  assert.match(laborSrc, /median_clockin_delta_min: verdict\.best\.median_clockin_delta_min/);
  assert.match(laborSrc, /runner_up_median_clockin_delta_min/);
  assert.match(laborSrc, /candidate_pool_size/);
  assert.match(laborSrc, /eligible_count/);
  assert.match(laborSrc, /time_ceiling_min: TIME_CEILING_MIN/);
});

test("§5a: candidacy is blocked only by mappings that carry punches", () => {
  assert.match(laborSrc, /blockedEmployeeIds\(/);
  assert.match(laborSrc, /punch_count: punchIndex\.punchCountByGuid\.get/);
});

test("§5c: the clock-in audit runs over EVERY crosswalk row and reaches the alert path", () => {
  assert.match(laborSrc, /attribution_audit_flags/);
  assert.match(laborSrc, /attribution audit flagged/);
  // The audit covers every method — it iterates crosswalk rows, not a
  // method-filtered subset.
  assert.doesNotMatch(
    laborSrc.split("§5c audit")[1]?.slice(0, 1200) ?? "",
    /match_method[^,\n]*===/,
    "the audit must not filter by match_method"
  );
});

test("§5e: the SA confirm re-stamps every punch row, and the one-shot reconciler exists", () => {
  assert.match(actionsSrc, /restampPunches\(supabase, guid, employeeId\)/);
  // restampPunches must NOT carry the null-only guard that stranded 31 rows.
  const restampFn = laborSrc.split("export async function restampPunches")[1]?.split("export")[0] ?? "";
  assert.ok(restampFn.length > 0, "restampPunches present");
  assert.doesNotMatch(restampFn, /\.is\("employee_id", null\)/, "re-stamp must move wrong-stamped rows too");
  assert.match(restampSrc, /reconcileAttributions\(supabase, loc\.id\)/);
});

test("the queue-growth alert rides the existing ingest-alert path (§4 guard 4)", () => {
  assert.match(laborSrc, /unmatched crosswalk queue grew/);
  assert.match(laborSrc, /maybeSendFailureAlert\(outcomes, extraReasons\)/);
});

test("both crosswalk server actions re-check system_admin", () => {
  const gates = actionsSrc.match(/role !== "system_admin"/g) ?? [];
  assert.ok(gates.length >= 2, `expected SA gates in confirm AND undo, found ${gates.length}`);
});

test("mig 055: RLS enabled on both tables; ingest_runs allows toast_labor", () => {
  assert.match(migSrc, /alter table public\.toast_employee_crosswalk enable row level security/);
  assert.match(migSrc, /alter table public\.toast_time_entries enable row level security/);
  assert.match(migSrc, /'toast_labor'/);
});

test("the nightly is scheduled and lands between the 7shifts/CP family and the kitchen pull", () => {
  assert.match(vercelJson, /"\/api\/cron\/sync-toast-labor"/);
  assert.match(vercelJson, /"55 9 \* \* \*"/);
});

test("§1 (addendum 2026-08-25): NO hardcoded window floor — the store's own go-live is the only one", () => {
  // A "2026-07-01" constant here + the route's matching default out-maxed
  // Houston's 2026-04-30 go-live and hid 501 punches for two months. The
  // window floor is locations.toast_sales_start_date, nothing else.
  const kitchenSrc = read("src/lib/ingest/toast/kitchen-ingest.ts");
  const orchestratorSrc = read("src/lib/ingest/toast/orchestrator.ts");
  const probeSrc = read("src/app/api/admin/probe-toast-labor/route.ts");
  for (const [name, src] of [
    ["labor.ts", laborSrc],
    ["backfill route", backfillSrc],
    ["kitchen-ingest.ts", kitchenSrc],
    // Codex 2026-08-25: the sales orchestrator carried the same fallback,
    // and the probe's default window preserved the Houston blind spot.
    ["orchestrator.ts", orchestratorSrc],
    ["probe route", probeSrc],
  ] as const) {
    assert.doesNotMatch(
      src,
      /LABOR_BACKFILL_FLOOR|["']2026-07-01["']/,
      `${name} must not carry a hardcoded window floor`
    );
  }
  // The route passes since through unchanged; absent means each store's
  // own floor, never a constant.
  assert.match(backfillSrc, /searchParams\.get\("since"\) \?\? undefined/);
  // The probe states its window explicitly — no default at all (§7).
  assert.match(probeSrc, /start and end \(YYYY-MM-DD\) are required/);
});

test("§1: a null go-live FAILS LOUDLY — a missing store fact is a data error, not a default", () => {
  const kitchenSrc = read("src/lib/ingest/toast/kitchen-ingest.ts");
  const orchestratorSrc = read("src/lib/ingest/toast/orchestrator.ts");
  assert.match(laborSrc, /no toast_sales_start_date/);
  assert.match(kitchenSrc, /no toast_sales_start_date/);
  assert.match(orchestratorSrc, /no toast_sales_start_date/);
});

test("§1: the resolved window is logged and returned on every run", () => {
  // Two requests where four were expected was the ONLY visible symptom of
  // the Houston blind spot — the window must be in the log line and in the
  // summary outcome, with the request count.
  assert.match(laborSrc, /since: sinceDate,\s*\n\s*until: untilDate,\s*\n\s*requests: detail\.requests/);
  assert.match(laborSrc, /window_start: o\.window_start/);
  assert.match(laborSrc, /window_end: o\.window_end/);
});

test("a route named backfill BACKFILLS: floor intent by default; the cron stays incremental", () => {
  // 2026-08-25, second window defect: once punches exist, the shared
  // no-since path is always the 3-day high-water incremental — the estate
  // re-backfill silently ran window_start 2026-08-22 at every store. The
  // backfill route must declare floor intent; the cron must never.
  assert.match(backfillSrc, /fromFloor: !since/);
  assert.doesNotMatch(cronSrc, /fromFloor/);
  // The intent branch precedes the high-water branch in the resolution.
  const fromFloorBranch = laborSrc.indexOf("options.fromFloor");
  const highWater = laborSrc.indexOf("lastSuccessfulWindowEnd(supabase, TOAST_LABOR_SOURCE");
  assert.ok(
    fromFloorBranch > 0 && highWater > 0 && fromFloorBranch < highWater,
    "fromFloor must be resolved before the incremental high-water mark"
  );
});

test("an explicit since WINS over fromFloor — the intent flag can never widen a deliberate window", () => {
  // Codex 2026-08-25: source-order alone would pass if a bare
  // `if (options.fromFloor)` overrode since. Pin the branch STRUCTURE:
  // fromFloor is an `else if` behind the since branch, so when both are
  // set the resolved start is the (go-live-floored) since, never the floor.
  assert.match(
    laborSrc,
    /if \(options\.since\) \{\s*\n\s*sinceDate =\s*\n?\s*options\.since > loc\.labor_start_date \? options\.since : loc\.labor_start_date;\s*\n\s*\} else if \(options\.fromFloor\) \{/,
    "fromFloor must be the else-if behind the since branch"
  );
});

// ── §7a: the auto-close correction (spec rev 2, mig 079) ───────────────────

const mig079 = read("supabase/migrations/079_auto_close_correction.sql");

test("§7a: corrected_out_at lives on toast_time_entries and NEVER on time_entries", () => {
  // time_entries carries an unconditional BEFORE UPDATE trigger bumping the
  // exact updated_at that mig 072's ghost guard reads — a correction written
  // there would mark ghosts as freshly served and suppress departures.
  assert.match(mig079, /alter table public\.toast_time_entries\s*\n\s*add column if not exists corrected_out_at/);
  assert.doesNotMatch(mig079, /alter table public\.time_entries/);
  assert.doesNotMatch(mig079, /update public\.time_entries/);
});

test("§7a: the vendor's out_at is KEPT AS RECEIVED — the correction sits beside it", () => {
  // An upstream value is a claim; overwriting it destroys the ability to
  // check the claim later. The function may only ever SET corrected_out_at.
  const setClauses = mig079.match(/set\s+\w+\s*=/gi) ?? [];
  for (const clause of setClauses) {
    assert.match(clause, /corrected_out_at/, `only corrected_out_at may be written, saw: ${clause}`);
  }
});

test("§7a: corrected hours are RECOMPUTED from the interval, never scaled from vendor fields", () => {
  // Toast assigns phantom hours to OVERTIME (Rexroad 08-01: regular 0.00,
  // overtime 17.38) — the vendor's hour fields embed the inflation, so the
  // corrected branch must derive from the corrected interval and must win
  // over the vendor-hours branch in the CASE order.
  const correctedBranch = mig079.indexOf("when tte.corrected_out_at is not null");
  const vendorHoursBranch = mig079.indexOf("when tte.regular_hours is not null or tte.overtime_hours is not null");
  assert.ok(correctedBranch > 0 && vendorHoursBranch > 0 && correctedBranch < vendorHoursBranch,
    "corrected-interval branch must precede the vendor-hours branch");
  assert.match(mig079, /extract\(epoch from \(tte\.corrected_out_at - tte\.in_at\)\) \/ 3600\.0/);
});

test("§7a: idempotent (NULL-guarded) and a scheduled end at/before clock-in is not a correction", () => {
  assert.match(mig079, /where tte\.corrected_out_at is null/);
  assert.match(mig079, /and s\.sched_end > s\.in_at/);
});

test("§7a: execute is service_role-only", () => {
  assert.match(mig079, /revoke execute on function public\.apply_auto_close_corrections\(\)\s*\n\s*from public, anon, authenticated/);
  assert.match(mig079, /grant execute on function public\.apply_auto_close_corrections\(\) to service_role/);
});

test("§7a: the ongoing pass rides the nightly — after all store passes, non-fatal, alert on failure", () => {
  // One home for the rule: the ingest calls the SAME function the backfill
  // used. It must run after the per-store loop (fresh punches first), its
  // failure must reach extraReasons (the alert path) rather than throw, and
  // its counts must land on the summary — a silently-skipped correction is
  // the "absence is not a signal" trap.
  assert.match(laborSrc, /supabase\.rpc\("apply_auto_close_corrections"\)/);
  assert.match(laborSrc, /extraReasons\.push\(`toast_labor auto-close correction pass failed/);
  assert.match(laborSrc, /auto_close_correction: autoCloseCorrection/);
  const rpcAt = laborSrc.indexOf('supabase.rpc("apply_auto_close_corrections")');
  const alertAt = laborSrc.indexOf("maybeSendFailureAlert(outcomes, extraReasons)");
  const loopEndAt = laborSrc.indexOf("await sleep(REQUEST_DELAY_MS);");
  assert.ok(loopEndAt > 0 && loopEndAt < rpcAt, "the pass runs after the per-store loop");
  assert.ok(rpcAt < alertAt, "the pass runs before the alert so its failure can ride it");
});

test("§7a: NOTHING in the migration recomputes scores — the gated recompute is the only mover", () => {
  // The gate holds the deployment, not just the write (ruling 13). The
  // migration stamps annotations; scored values move only in the single
  // reviewed recompute pass.
  assert.doesNotMatch(mig079, /performance_records/);
  assert.doesNotMatch(mig079, /recompute_employee|recompute_team|compute_employee/);
});
