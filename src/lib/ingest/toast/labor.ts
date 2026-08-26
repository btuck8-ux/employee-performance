/**
 * Toast Labor time entries -> EPD `toast_time_entries` + the
 * `toast_employee_crosswalk` auto-matcher (workstream I, Tucker's rulings
 * 2026-08-23: "7shifts = scheduled shift time. Toast = actual clock-in/out
 * time"). The 7 Toast stores' punches never reach 7shifts — this feed is how
 * EPD stops scoring people absent whose clock-ins exist in Toast (the
 * Step-0 retraction's twelve-employee list).
 *
 * ⚠️ THIS FEED NEVER WRITES time_entries (pinned by test). time_entries is
 * UNIQUE (employee_id, entry_date, entry_type) and sevenshifts/time.ts
 * upserts entry_type='worked' on that key nightly — a second worked-time
 * writer would fight it, last writer wins. Punches land in their own
 * per-punch table (mig 055) and run in parallel; switching the metric /
 * locations.actuals_source is a separate evidenced decision (the 2026-07-27
 * audit: a naive flip "kills CO labor"). Since the 2026-08-24 defect fix,
 * schedule evidence comes from seven_shifts_shifts (it carries start_at;
 * time_entries does not) — this module no longer touches time_entries at
 * all.
 *
 * Store scoping: strictly locations.toast_restaurant_guid (ruling §6). The
 * credential also reaches Chico CA and a stray second Fort Collins; labor
 * requests are per-restaurant (Toast-Restaurant-External-ID header), so
 * scoping the loop IS the allow-list. HOU is a Toast store for LABOR even
 * though its SALES ride 7shifts pos_receipts (mig 042's double-source trap
 * is about sales routing, not punches) — hence this loader keys on the GUID,
 * NOT on toast_sales_enabled. NOLA has no GUID and can never enter the loop.
 *
 * Endpoint contract (Step-0 probe, 2026-08-23 — don't re-probe):
 * /labor/v1/timeEntries honours businessDate=yyyyMMdd and startDate/endDate
 * windows up to 30 days (longer → 400 code 10000), no pagination, ~20-req
 * rate window → keep request spacing. /labor/v1/employees returns the full
 * roster including deleted staff (good: the crosswalk covers departed
 * people). Natural punch key: the time-entry guid.
 */

import { toastGet } from "./client";
import type { AdminClient } from "../sevenshifts/crosswalk";
import {
  startRun,
  finishRun,
  lastSuccessfulWindowEnd,
  type RunOutcome,
} from "../sevenshifts/runs";
import { maybeSendFailureAlert } from "../sevenshifts/alert";
import {
  classifyPunches,
  planEmailSeeds,
  scoreTimeAwareMatch,
  medianAbsDeltaMinutes,
  blockedEmployeeIds,
  chunkWindows,
  BEHAVIOURAL_MIN_OVERLAP_DAYS,
  TIME_CEILING_MIN,
  TIME_RUNNER_UP_MARGIN_MIN,
  AUDIT_MIN_PAIRED_DAYS,
  type RawToastEmployee,
  type RawToastTimeEntry,
  type TimeAwareCandidate,
} from "./labor-core";

export const TOAST_LABOR_SOURCE = "toast_labor" as const;

// ⚠️ There is deliberately NO fallback window floor here (§1, addendum
// 2026-08-25). A hardcoded July-1st floor + the route's matching default
// hid 501 Houston punches for two months: HOU's real go-live is 2026-04-30,
// and the max() in the window resolution silently discarded it in favour of
// the constant. The store's own toast_sales_start_date is the ONLY floor; a
// null go-live on a GUID-bearing store is a data error that fails loudly.
//
// ⚠️ LOAD-BEARING PAIR with mig 058's v_worked_intervals (addendum 2 §3):
// its null-go-live branch keeps such a store's time_entries history
// precisely BECAUSE this loud failure guarantees no Toast rows can be
// ingested for it. Neither behaviour is safe to remove without the other —
// the cross-reference lives in both headers on purpose.

const REQUEST_DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ToastLaborLocation {
  id: string;
  location_code: string;
  toast_restaurant_guid: string;
  /** YYYY-MM-DD Toast go-live — the hard floor for every labor pull. */
  labor_start_date: string;
}

/** The 7 Toast stores — GUID-scoped, per ruling §6 / the module header. */
export async function loadToastLaborLocations(
  supabase: AdminClient
): Promise<ToastLaborLocation[]> {
  const { data, error } = await supabase
    .from("locations")
    .select("id, location_code, toast_restaurant_guid, toast_sales_start_date")
    .not("toast_restaurant_guid", "is", null)
    .order("location_code");
  if (error) throw new Error(`Toast labor locations: ${error.message}`);
  return (data ?? [])
    .filter((r) => r.toast_restaurant_guid)
    .map((r) => {
      const goLive = (r.toast_sales_start_date as string | null) ?? null;
      if (!goLive) {
        // Fail loudly, never guess (§1): a store with a Toast GUID but no
        // go-live date can't be windowed correctly — set
        // locations.toast_sales_start_date first.
        throw new Error(
          `Toast labor: ${String(r.location_code)} has a toast_restaurant_guid but no toast_sales_start_date — set the store's go-live before ingesting`
        );
      }
      return {
        id: r.id as string,
        location_code: r.location_code as string,
        toast_restaurant_guid: r.toast_restaurant_guid as string,
        labor_start_date: goLive,
      };
    });
}

export async function fetchToastEmployees(
  restaurantGuid: string
): Promise<RawToastEmployee[]> {
  return toastGet<RawToastEmployee[]>(restaurantGuid, "/labor/v1/employees");
}

/** Pull [sinceDate, untilDate] inclusive as ≤28-day chunks (30-day API cap). */
export async function fetchTimeEntriesWindow(
  restaurantGuid: string,
  sinceDate: string,
  untilDate: string
): Promise<{ entries: RawToastTimeEntry[]; requests: number }> {
  const chunks = chunkWindows(sinceDate, untilDate);
  const entries: RawToastTimeEntry[] = [];
  for (const [i, chunk] of chunks.entries()) {
    if (i > 0) await sleep(REQUEST_DELAY_MS);
    const batch = await toastGet<RawToastTimeEntry[]>(
      restaurantGuid,
      "/labor/v1/timeEntries",
      { startDate: chunk.startIso, endDate: chunk.endIso }
    );
    if (Array.isArray(batch)) entries.push(...batch);
  }
  return { entries, requests: chunks.length };
}

const PAGE = 1000;

/** toast_employee_guid -> employee_id for one location, paged past
 * PostgREST's 1000-row cap (PR #21 Codex finding 3 doctrine). */
export async function loadCrosswalkMap(
  supabase: AdminClient,
  locationId: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("toast_employee_crosswalk")
      .select("toast_employee_guid, employee_id")
      .eq("location_id", locationId)
      .order("toast_employee_guid", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`toast crosswalk read: ${error.message}`);
    for (const r of data ?? []) {
      out.set(String(r.toast_employee_guid), String(r.employee_id));
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/**
 * Re-align every stored punch's employee_id with the CURRENT crosswalk —
 * the single source of attribution truth (Codex 2026-08-23 findings: a
 * concurrent SA confirm/undo mid-run must not be clobbered by a stale
 * snapshot, and an ignoreDuplicates race must not attribute to the losing
 * plan). Runs after every upsert/matcher pass and each nightly, so any
 * transient drift — including a mid-undo race on the SA surface —
 * self-heals from DB state.
 */
export async function reconcileAttributions(
  supabase: AdminClient,
  locationId: string
): Promise<{ attributed_guids: number; deattributed_guids: number }> {
  const truth = await loadCrosswalkMap(supabase, locationId);
  // Observed attribution per guid (paged): any row disagreeing with truth
  // marks its guid for a corrective per-guid update.
  const observed = new Map<string, Set<string | null>>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("toast_time_entries")
      .select("toast_employee_guid, employee_id")
      .eq("location_id", locationId)
      .order("toast_time_entry_guid", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`attribution scan: ${error.message}`);
    for (const r of data ?? []) {
      const guid = String(r.toast_employee_guid);
      const set = observed.get(guid) ?? new Set<string | null>();
      set.add(r.employee_id ? String(r.employee_id) : null);
      observed.set(guid, set);
    }
    if (!data || data.length < PAGE) break;
  }
  let attributed = 0;
  let deattributed = 0;
  for (const [guid, values] of observed) {
    const want = truth.get(guid) ?? null;
    const mismatch = [...values].some((v) => v !== want);
    if (!mismatch) continue;
    const { error } = await supabase
      .from("toast_time_entries")
      .update({ employee_id: want })
      .eq("location_id", locationId)
      .eq("toast_employee_guid", guid);
    if (error) throw new Error(`attribution fix: ${error.message}`);
    if (want) attributed += 1;
    else deattributed += 1;
  }
  return { attributed_guids: attributed, deattributed_guids: deattributed };
}

/**
 * Re-stamp EVERY stored punch for a guid to its (new) owner — §5e: a
 * crosswalk edit must reach the punch rows, including rows previously
 * stamped for someone else. The old attribute-only-null version left 31
 * punch rows pointing at the wrong employee after the 2026-08-24
 * correction. Used by the SA confirm action; the nightly's
 * reconcileAttributions covers the same invariant continuously.
 */
export async function restampPunches(
  supabase: AdminClient,
  toastEmployeeGuid: string,
  employeeId: string
): Promise<void> {
  const { error } = await supabase
    .from("toast_time_entries")
    .update({ employee_id: employeeId })
    .eq("toast_employee_guid", toastEmployeeGuid);
  if (error) throw new Error(`punch re-stamp: ${error.message}`);
}

/** Undo path: clear the attribution a removed crosswalk row created. */
export async function deattributeStoredPunches(
  supabase: AdminClient,
  toastEmployeeGuid: string
): Promise<void> {
  const { error } = await supabase
    .from("toast_time_entries")
    .update({ employee_id: null })
    .eq("toast_employee_guid", toastEmployeeGuid);
  if (error) throw new Error(`punch de-attribution: ${error.message}`);
}

/** Employees at a location (paged), optionally active-only. */
async function employeesAtLocation(
  supabase: AdminClient,
  locationId: string,
  activeOnly: boolean
): Promise<Array<{ id: string; email: string | null }>> {
  const out: Array<{ id: string; email: string | null }> = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from("employees")
      .select("id, email, active")
      .eq("location_id", locationId)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (activeOnly) q = q.eq("active", true);
    const { data, error } = await q;
    if (error) throw new Error(`employees read: ${error.message}`);
    for (const r of data ?? []) {
      out.push({ id: String(r.id), email: (r.email as string | null) ?? null });
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/**
 * Scheduled START TIMES per employee per store-local date, from the direct
 * 7shifts feed (seven_shifts_shifts — it carries start_at; time_entries
 * does not). §5b's time evidence rides this. Earliest shift wins a
 * multi-shift day, matching the earliest-punch pairing on the Toast side.
 * Tombstoned/deleted/draft shifts are excluded.
 */
async function scheduledStartsByEmployee(
  supabase: AdminClient,
  employeeIds: string[],
  sinceDate: string,
  untilDate: string
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  if (employeeIds.length === 0) return out;
  const BATCH = 1000;
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await supabase
      .from("seven_shifts_shifts")
      .select("employee_id, entry_date, start_at")
      .in("employee_id", employeeIds)
      .is("missing_upstream_since", null)
      .eq("deleted", false)
      .eq("draft", false)
      .gte("entry_date", sinceDate)
      .lte("entry_date", untilDate)
      .order("seven_shifts_shift_id", { ascending: true })
      .range(from, from + BATCH - 1);
    if (error) throw new Error(`scheduled starts read: ${error.message}`);
    for (const r of data ?? []) {
      const id = String(r.employee_id);
      const date = String(r.entry_date).slice(0, 10);
      const startAt = String(r.start_at);
      const byDate = out.get(id) ?? new Map<string, string>();
      const prev = byDate.get(date);
      if (!prev || startAt < prev) byDate.set(date, startAt);
      out.set(id, byDate);
    }
    if (!data || data.length < BATCH) break;
  }
  return out;
}

interface PunchIndex {
  /** guid -> store-local date -> earliest clock-in (non-deleted punches). */
  inByGuid: Map<string, Map<string, string>>;
  /** guid -> total non-deleted punch rows. */
  punchCountByGuid: Map<string, number>;
}

/** One paged pass over a store's stored punches — feeds §5a eligibility,
 * the matcher's evidence, the §5c audit, and the queue, without re-reading. */
async function loadPunchIndex(
  supabase: AdminClient,
  locationId: string
): Promise<PunchIndex> {
  const inByGuid = new Map<string, Map<string, string>>();
  const punchCountByGuid = new Map<string, number>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("toast_time_entries")
      .select("toast_employee_guid, entry_date, in_at")
      .eq("location_id", locationId)
      .eq("deleted", false)
      .order("toast_time_entry_guid", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`punch index read: ${error.message}`);
    for (const r of data ?? []) {
      const guid = String(r.toast_employee_guid);
      const date = String(r.entry_date).slice(0, 10);
      const inAt = String(r.in_at);
      punchCountByGuid.set(guid, (punchCountByGuid.get(guid) ?? 0) + 1);
      const byDate = inByGuid.get(guid) ?? new Map<string, string>();
      const prev = byDate.get(date);
      if (!prev || inAt < prev) byDate.set(date, inAt);
      inByGuid.set(guid, byDate);
    }
    if (!data || data.length < PAGE) break;
  }
  return { inByGuid, punchCountByGuid };
}

/** Crosswalk rows (guid, employee, method) at a location, paged. */
async function crosswalkRowsAtLocation(
  supabase: AdminClient,
  locationId: string
): Promise<Array<{ toast_employee_guid: string; employee_id: string; match_method: string }>> {
  const out: Array<{ toast_employee_guid: string; employee_id: string; match_method: string }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("toast_employee_crosswalk")
      .select("toast_employee_guid, employee_id, match_method")
      .eq("location_id", locationId)
      .order("toast_employee_guid", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`crosswalk rows read: ${error.message}`);
    for (const r of data ?? []) {
      out.push({
        toast_employee_guid: String(r.toast_employee_guid),
        employee_id: String(r.employee_id),
        match_method: String(r.match_method),
      });
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export interface AttributionAuditFlag {
  toast_employee_guid: string;
  employee_id: string;
  match_method: string;
  paired_days: number;
  median_clockin_delta_min: number;
}

export interface LaborLocationDetail {
  requests: number;
  entries_pulled: number;
  punches_upserted: number;
  email_seeded: number;
  email_ambiguous: number;
  auto_matched: number;
  auto_ambiguous: number;
  auto_insufficient: number;
  /** Unmatched Toast guids that HAVE punches after this run — the SA queue. */
  unmatched_queue_size: number;
  unmatched_toast_employee_guids: string[];
  /** §5c: crosswalk rows (ANY method) whose punches don't land near the
   * mapped employee's scheduled starts — surfaced every run, alerted on. */
  attribution_audit_flags: AttributionAuditFlag[];
  skipped_no_guid: number;
  skipped_no_date: number;
  skipped_no_in: number;
  /** §3 (demarcation packet 2026-08-26): punches whose regular+OT hours
   * exceed 16 — flagged, never capped; written faithfully. */
  punches_over_16h: number;
  punches_over_16h_sample: Array<{
    toast_time_entry_guid: string;
    entry_date: string;
    hours: number;
  }>;
}

/**
 * One store's full pass: email seeding → punch pull/upsert → behavioural
 * matcher → attribution. Returns counts for the run row; throws on hard IO
 * failure (caller marks the run errored).
 */
export async function ingestToastLaborForLocation(
  supabase: AdminClient,
  loc: ToastLaborLocation,
  sinceDate: string,
  untilDate: string,
  nowIso: string
): Promise<LaborLocationDetail> {
  // 1) Email seeding (deterministic; ruling §4 path 1). Roster includes
  //    deleted Toast staff — deliberate, departed people crosswalk too.
  //    No interleaved attribution: reconcileAttributions() at the end is
  //    the single writer of punch attribution, from fresh DB truth.
  const toastRoster = await fetchToastEmployees(loc.toast_restaurant_guid);
  const epdEmps = await employeesAtLocation(supabase, loc.id, false);
  const existing = await loadCrosswalkMap(supabase, loc.id);
  const plan = planEmailSeeds(toastRoster, epdEmps, new Set(existing.keys()));
  if (plan.seeds.length > 0) {
    const { error } = await supabase.from("toast_employee_crosswalk").upsert(
      plan.seeds.map((s) => ({
        toast_employee_guid: s.toast_employee_guid,
        employee_id: s.employee_id,
        location_id: loc.id,
        match_method: "email",
      })),
      { onConflict: "toast_employee_guid", ignoreDuplicates: true }
    );
    if (error) throw new Error(`email seed upsert: ${error.message}`);
    for (const s of plan.seeds) existing.set(s.toast_employee_guid, s.employee_id);
  }

  // 2) Punch pull + upsert. classifyPunches attributes from the snapshot as
  //    a first pass; the reconcile step below re-aligns from DB truth so a
  //    concurrent SA confirm/undo can't be clobbered by this snapshot.
  await sleep(REQUEST_DELAY_MS);
  const { entries, requests } = await fetchTimeEntriesWindow(
    loc.toast_restaurant_guid,
    sinceDate,
    untilDate
  );
  const classified = classifyPunches(entries, loc.id, existing, nowIso);
  // §3 (demarcation packet 2026-08-26): flag >16h punches at read time.
  const over16h = classified.rows
    .map((r) => ({
      toast_time_entry_guid: r.toast_time_entry_guid,
      entry_date: r.entry_date,
      hours:
        Math.round(((r.regular_hours ?? 0) + (r.overtime_hours ?? 0)) * 100) /
        100,
    }))
    .filter((r) => r.hours > 16);
  let upserted = 0;
  const UPSERT_BATCH = 500;
  for (let i = 0; i < classified.rows.length; i += UPSERT_BATCH) {
    const batch = classified.rows.slice(i, i + UPSERT_BATCH);
    const { error } = await supabase
      .from("toast_time_entries")
      .upsert(batch, { onConflict: "toast_time_entry_guid" });
    if (error) throw new Error(`toast_time_entries upsert: ${error.message}`);
    upserted += batch.length;
  }

  // 3) Time-aware behavioural matcher (defect 2026-08-24 §5b) over
  //    unmatched guids with punches. Punch evidence comes from ALL stored
  //    punches for the guid so it accumulates night over night. TWO-PHASE
  //    (Codex 2026-08-23): every guid scores against the full pool first;
  //    two guids auto-resolving to the same employee is itself ambiguity.
  const punchIndex = await loadPunchIndex(supabase, loc.id);
  const xwalkRows = await crosswalkRowsAtLocation(supabase, loc.id);
  const mappedGuids = new Set(xwalkRows.map((r) => r.toast_employee_guid));
  // §5a: only a mapping that actually carries punches blocks its owner. A
  // zero-punch mapping (stale POS account) leaves the employee eligible —
  // the CPD mis-attribution happened because the true owner was excluded
  // on the strength of an account he never punched on.
  const blocked = blockedEmployeeIds(
    xwalkRows.map((r) => ({
      employee_id: r.employee_id,
      punch_count: punchIndex.punchCountByGuid.get(r.toast_employee_guid) ?? 0,
    }))
  );
  const candidatesRaw = (await employeesAtLocation(supabase, loc.id, true)).filter(
    (c) => !blocked.has(c.id)
  );
  const scheduleIds = [
    ...new Set([...candidatesRaw.map((c) => c.id), ...xwalkRows.map((r) => r.employee_id)]),
  ];
  const schedules = await scheduledStartsByEmployee(
    supabase,
    scheduleIds,
    loc.labor_start_date,
    untilDate
  );
  // Mutual-exclusion evidence (spec 2026-08-25 §5b): days each candidate
  // already punched via their OWN mapped GUID(s). Built from the punch
  // index the matcher already holds — no extra reads.
  //
  // ⚠️ LAYERING (Codex 2026-08-25): in THIS pipeline §5a already removes
  // every punched-mapping owner from candidacy at the ACCOUNT level, so
  // the day-level exclusion below is defense-in-depth here — its live
  // count is expected to be 0 (zero-punch-mapping owners have no punch
  // days; unmapped candidates have no own GUID). The primitive earns its
  // keep in scoreTimeAwareMatch itself, which full-pool scorings (the
  // 6c62e9c8 re-rank, audit tooling) call WITHOUT the §5a filter — and it
  // guards this pipeline if §5a's shape ever changes. A 0 in the evidence
  // means "no conflicts among the residual pool", not "no conflicts".
  const ownPunchDaysByEmployee = new Map<string, Set<string>>();
  for (const r of xwalkRows) {
    const dates = punchIndex.inByGuid.get(r.toast_employee_guid);
    if (!dates) continue;
    const set = ownPunchDaysByEmployee.get(r.employee_id) ?? new Set<string>();
    for (const d of dates.keys()) set.add(d);
    ownPunchDaysByEmployee.set(r.employee_id, set);
  }

  const candidates: TimeAwareCandidate[] = candidatesRaw.map((c) => ({
    employee_id: c.id,
    scheduleStartByDate: schedules.get(c.id) ?? new Map<string, string>(),
    ownPunchDays: ownPunchDaysByEmployee.get(c.id),
  }));

  const unmatchedEntries = [...punchIndex.inByGuid.entries()].filter(
    ([guid]) => !mappedGuids.has(guid)
  );
  const verdicts = unmatchedEntries.map(([guid, punchInByDate]) => ({
    guid,
    verdict: scoreTimeAwareMatch(punchInByDate, candidates),
  }));
  const autoTargets = new Map<string, number>();
  for (const v of verdicts) {
    if (v.verdict.decision === "auto" && v.verdict.best) {
      const key = v.verdict.best.employee_id;
      autoTargets.set(key, (autoTargets.get(key) ?? 0) + 1);
    }
  }

  let autoMatched = 0;
  let autoAmbiguous = 0;
  let autoInsufficient = 0;
  for (const { guid, verdict } of verdicts) {
    if (verdict.decision !== "auto" || !verdict.best) {
      if (verdict.decision === "ambiguous") autoAmbiguous += 1;
      else autoInsufficient += 1;
      continue;
    }
    if ((autoTargets.get(verdict.best.employee_id) ?? 0) > 1) {
      // Two punch accounts both clearing the bar for one person — queue
      // both for the SA rather than picking.
      autoAmbiguous += 1;
      continue;
    }
    const employeeId = verdict.best.employee_id;
    const { error } = await supabase.from("toast_employee_crosswalk").upsert(
      {
        toast_employee_guid: guid,
        employee_id: employeeId,
        location_id: loc.id,
        match_method: "auto_behavioural",
        // §5b + §5d: time evidence and pool visibility on every auto row —
        // a null runner-up is distinguishable from a walkover.
        evidence: {
          punch_days: verdict.punch_days,
          best_overlap_days: verdict.best.overlap_days,
          median_clockin_delta_min: verdict.best.median_clockin_delta_min,
          runner_up_overlap_days: verdict.runner_up?.overlap_days ?? null,
          runner_up_median_clockin_delta_min:
            verdict.runner_up?.median_clockin_delta_min ?? null,
          candidate_pool_size: verdict.candidate_pool_size,
          eligible_count: verdict.eligible_count,
          mutually_excluded_count: verdict.mutually_excluded_count,
          thresholds: {
            min_overlap_days: BEHAVIOURAL_MIN_OVERLAP_DAYS,
            time_ceiling_min: TIME_CEILING_MIN,
            time_margin_min: TIME_RUNNER_UP_MARGIN_MIN,
          },
          window: { since: loc.labor_start_date, until: untilDate },
          decided_at: nowIso,
        },
      },
      { onConflict: "toast_employee_guid", ignoreDuplicates: true }
    );
    if (error) throw new Error(`auto-match upsert: ${error.message}`);
    autoMatched += 1;
    console.log("[toast-labor] behavioural auto-match", {
      location: loc.location_code,
      toast_employee_guid: guid,
      employee_id: employeeId,
      overlap_days: verdict.best.overlap_days,
      median_clockin_delta_min: verdict.best.median_clockin_delta_min,
    });
  }

  // 4) Attribution reconciliation — the single writer, from fresh DB truth
  //    (covers email seeds, auto-matches, SA confirms/undos, and any
  //    ignoreDuplicates race above in one idempotent pass).
  await reconcileAttributions(supabase, loc.id);

  // 5) §5c audit — EVERY crosswalk row, whatever method created it, gets
  //    the independent clock-in-vs-scheduled-start check each run. Email
  //    determinism is not correctness (the 302-minute email row proved it).
  const freshRows = await crosswalkRowsAtLocation(supabase, loc.id);
  const auditFlags: AttributionAuditFlag[] = [];
  for (const row of freshRows) {
    const punchInByDate = punchIndex.inByGuid.get(row.toast_employee_guid);
    if (!punchInByDate) continue;
    const sched = schedules.get(row.employee_id);
    if (!sched) continue;
    const { paired_days, median_min } = medianAbsDeltaMinutes(punchInByDate, sched);
    if (
      paired_days >= AUDIT_MIN_PAIRED_DAYS &&
      median_min !== null &&
      median_min > TIME_CEILING_MIN
    ) {
      auditFlags.push({
        toast_employee_guid: row.toast_employee_guid,
        employee_id: row.employee_id,
        match_method: row.match_method,
        paired_days,
        median_clockin_delta_min: Math.round(median_min * 10) / 10,
      });
    }
  }

  // 6) The queue after everything above: unmatched guids that still have
  //    punches. This is what the growth alert and the SA surface watch.
  const freshMapped = new Set(freshRows.map((r) => r.toast_employee_guid));
  const remaining = [...punchIndex.inByGuid.keys()].filter((g) => !freshMapped.has(g));

  return {
    requests,
    entries_pulled: entries.length,
    punches_upserted: upserted,
    email_seeded: plan.seeds.length,
    email_ambiguous: plan.ambiguousEmails,
    auto_matched: autoMatched,
    auto_ambiguous: autoAmbiguous,
    auto_insufficient: autoInsufficient,
    unmatched_queue_size: remaining.length,
    unmatched_toast_employee_guids: remaining.slice(0, 20),
    attribution_audit_flags: auditFlags,
    skipped_no_guid: classified.skippedNoGuid,
    skipped_no_date: classified.skippedNoDate,
    skipped_no_in: classified.skippedNoIn,
    // §3 (2026-08-26): >16h single-punch totals — the never-clocked-out /
    // phantom-hours class. Flag, never cap; the rows above were written
    // faithfully and the flag is what tells a manager to fix the punch.
    punches_over_16h: over16h.length,
    punches_over_16h_sample: over16h.slice(0, 20),
  };
}

/** Previous run's queue size for the growth alert (ruling §4 guard 4). */
async function previousQueueSize(
  supabase: AdminClient,
  locationId: string
): Promise<number | null> {
  const { data, error } = await supabase
    .from("ingest_runs")
    .select("detail")
    .eq("source", TOAST_LABOR_SOURCE)
    .eq("location_id", locationId)
    .in("status", ["success", "empty"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const v = (data.detail as Record<string, unknown> | null)?.["unmatched_queue_size"];
  return typeof v === "number" ? v : null;
}

export interface ToastLaborSummary {
  started_at: string;
  finished_at: string;
  locations: number;
  runs: number;
  by_status: Record<string, number>;
  alert: { sent: boolean; reason: string };
  outcomes: Array<{
    location_code: string;
    status: string;
    /** §1: the resolved window rides every response — a wrong window must
     * be visible in the output, not just deducible from a request count. */
    window_start: string | null;
    window_end: string | null;
    rows_in: number;
    rows_upserted: number;
    rows_skipped: number;
    error_text: string | null;
  }>;
  /** §7a ongoing pass (mig 079): counts from apply_auto_close_corrections(),
   * or null when the RPC failed — the failure itself rides the alert path.
   * skipped_no_schedule is a standing count (those rows stay unstamped and
   * re-report every run — deliberate: report them, never guess). */
  auto_close_correction: {
    corrected: number;
    skipped_no_schedule: number;
    skipped_nonpositive: number;
  } | null;
}

export interface ToastLaborOptions {
  /** Restrict to one store (location_code). */
  locationCode?: string;
  /** Operator window-start override (YYYY-MM-DD), still floored at each
   * store's go-live. The beat-1 backfill lever passes the floor itself. */
  since?: string;
  /** Window INTENT (2026-08-25, post-re-backfill defect): true = start at
   * each store's go-live floor regardless of the high-water mark. Without
   * this, once punches exist the no-since path is ALWAYS the incremental
   * high-water branch — the estate "re-backfill" silently ran a 3-day
   * window, the same narrower-than-the-caller-expects shape §1 fixed. The
   * backfill route sets this whenever no explicit since is given; the cron
   * never does (incremental is its correct behaviour). */
  fromFloor?: boolean;
}

export async function runToastLaborIngest(
  options: ToastLaborOptions = {}
): Promise<ToastLaborSummary> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const startedAt = new Date().toISOString();
  const nowIso = startedAt;
  const untilDate = startedAt.slice(0, 10);

  let locations = await loadToastLaborLocations(supabase);
  if (options.locationCode) {
    locations = locations.filter((l) => l.location_code === options.locationCode);
    if (locations.length === 0) {
      throw new Error(
        `No Toast-labor location with code "${options.locationCode}".`
      );
    }
  }

  const outcomes: RunOutcome[] = [];
  const extraReasons: string[] = [];
  for (const loc of locations) {
    // Window resolution (§1, addendum 2026-08-25). Two distinct facts:
    // loc.labor_start_date — the store's OWN go-live — is how far back this
    // store CAN go (the hard floor; an operator override never reaches back
    // past it, the reconcile-worked-time precedent). options.since is how
    // far back this run WANTS to go. The clamp below is only safe because
    // no constant default reaches options.since any more: the route used to
    // default it to July 1st, which out-maxed Houston's 2026-04-30
    // go-live and hid 501 punches. Incremental runs use the high-water mark
    // minus a 2-day re-read margin (late edits to recent punches); the
    // first run starts at the floor — the backfill IS the first run, the
    // cp_schedule precedent.
    let sinceDate: string;
    if (options.since) {
      sinceDate =
        options.since > loc.labor_start_date ? options.since : loc.labor_start_date;
    } else if (options.fromFloor) {
      // Explicit backfill intent: the store's own go-live, always. The
      // "first run starts at the floor" fallback below can never fire again
      // once a store has a successful run, so a backfill must say so.
      sinceDate = loc.labor_start_date;
    } else {
      const prior = await lastSuccessfulWindowEnd(supabase, TOAST_LABOR_SOURCE, loc.id);
      if (prior) {
        const d = new Date(`${prior.slice(0, 10)}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 2);
        const rewound = d.toISOString().slice(0, 10);
        sinceDate = rewound > loc.labor_start_date ? rewound : loc.labor_start_date;
      } else {
        sinceDate = loc.labor_start_date;
      }
    }
    const windowStart = `${sinceDate}T00:00:00.000Z`;
    const windowEnd = `${untilDate}T23:59:59.999Z`;

    const runId = await startRun(supabase, TOAST_LABOR_SOURCE, loc.id, windowStart, windowEnd);
    const base: RunOutcome = {
      source: TOAST_LABOR_SOURCE,
      location_id: loc.id,
      location_code: loc.location_code,
      status: "running",
      rows_in: 0,
      rows_upserted: 0,
      rows_skipped: 0,
      detail: null,
      error_text: null,
      window_start: windowStart,
      window_end: windowEnd,
    };
    try {
      const prevQueue = await previousQueueSize(supabase, loc.id);
      const detail = await ingestToastLaborForLocation(
        supabase,
        loc,
        sinceDate,
        untilDate,
        nowIso
      );
      // §1: log the resolved window with the request count on every run.
      // Two requests where four were expected was the ONLY visible symptom
      // of the two-month Houston blind spot — make it impossible to miss.
      console.log(
        `[toast-labor] ${loc.location_code} window`,
        JSON.stringify({
          since: sinceDate,
          until: untilDate,
          requests: detail.requests,
        })
      );
      base.rows_in = detail.entries_pulled;
      base.rows_upserted = detail.punches_upserted;
      base.rows_skipped =
        detail.skipped_no_guid + detail.skipped_no_date + detail.skipped_no_in;
      base.detail = { ...detail };
      base.status = detail.punches_upserted > 0 ? "success" : "empty";
      // Queue-growth alert (ruling §4): new Toast guids silently failing to
      // resolve is the same shape that caused this whole incident.
      if (prevQueue !== null && detail.unmatched_queue_size > prevQueue) {
        extraReasons.push(
          `toast_labor unmatched crosswalk queue grew at ${loc.location_code}: ${prevQueue} → ${detail.unmatched_queue_size}`
        );
      }
      // §5c: a crosswalk row failing the independent clock-in audit must
      // reach someone, whatever method created it.
      if (detail.attribution_audit_flags.length > 0) {
        extraReasons.push(
          `toast_labor attribution audit flagged ${detail.attribution_audit_flags.length} row(s) at ${loc.location_code} (median clock-in deviation > ${TIME_CEILING_MIN}m)`
        );
      }
    } catch (err) {
      base.status = "error";
      base.error_text = err instanceof Error ? err.message : String(err);
    }
    await finishRun(supabase, runId, base);
    outcomes.push(base);
    await sleep(REQUEST_DELAY_MS);
  }

  // §7a ongoing pass (spec rev 2, mig 079): stamp corrected_out_at on any
  // auto-closed / never-closed punches this run upserted. The function is
  // estate-wide and idempotent (NULL-guarded), so one call after all store
  // passes covers every fresh row — the reconcileAttributions pattern, one
  // level up. Non-fatal: a failing correction pass must reach the alert
  // path, not sink the ingest — a silently-skipped correction is the
  // "absence is not a signal" trap.
  let autoCloseCorrection: ToastLaborSummary["auto_close_correction"] = null;
  {
    const { data, error } = await supabase.rpc("apply_auto_close_corrections");
    if (error) {
      extraReasons.push(`toast_labor auto-close correction pass failed: ${error.message}`);
    } else {
      const row = (Array.isArray(data) ? data[0] : data) as {
        corrected: number;
        skipped_no_schedule: number;
        skipped_nonpositive: number;
      } | null;
      if (row) {
        autoCloseCorrection = {
          corrected: row.corrected,
          skipped_no_schedule: row.skipped_no_schedule,
          skipped_nonpositive: row.skipped_nonpositive,
        };
        console.log("[toast-labor] auto-close correction", JSON.stringify(autoCloseCorrection));
      }
    }
  }

  const alert = await maybeSendFailureAlert(outcomes, extraReasons);
  const byStatus: Record<string, number> = {};
  for (const o of outcomes) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

  return {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    locations: locations.length,
    runs: outcomes.length,
    by_status: byStatus,
    alert,
    outcomes: outcomes.map((o) => ({
      location_code: o.location_code,
      status: o.status,
      window_start: o.window_start,
      window_end: o.window_end,
      rows_in: o.rows_in,
      rows_upserted: o.rows_upserted,
      rows_skipped: o.rows_skipped,
      error_text: o.error_text,
    })),
    auto_close_correction: autoCloseCorrection,
  };
}
