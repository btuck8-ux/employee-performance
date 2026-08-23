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
 * audit: a naive flip "kills CO labor"). This module reads time_entries
 * (scheduled rows, as behavioural-matcher evidence) and never writes it.
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
  scoreBehaviouralMatch,
  chunkWindows,
  BEHAVIOURAL_MIN_OVERLAP_DAYS,
  BEHAVIOURAL_RUNNER_UP_MARGIN,
  type RawToastEmployee,
  type RawToastTimeEntry,
  type BehaviouralCandidate,
} from "./labor-core";

export const TOAST_LABOR_SOURCE = "toast_labor" as const;

/** Earliest Toast go-live across the estate (CPD/HOU 2026-07-01) — the
 * fallback floor when a store's toast_sales_start_date is null. */
export const LABOR_BACKFILL_FLOOR = "2026-07-01";

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
    .map((r) => ({
      id: r.id as string,
      location_code: r.location_code as string,
      toast_restaurant_guid: r.toast_restaurant_guid as string,
      labor_start_date:
        (r.toast_sales_start_date as string | null) ?? LABOR_BACKFILL_FLOOR,
    }));
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

/** Attribute stored punches for a newly crosswalked guid. Never overwrites an
 * existing attribution (employee_id must be null). Shared by the seeder, the
 * behavioural matcher, and the SA manual-confirm action. */
export async function attributeStoredPunches(
  supabase: AdminClient,
  toastEmployeeGuid: string,
  employeeId: string
): Promise<void> {
  const { error } = await supabase
    .from("toast_time_entries")
    .update({ employee_id: employeeId })
    .eq("toast_employee_guid", toastEmployeeGuid)
    .is("employee_id", null);
  if (error) throw new Error(`punch attribution: ${error.message}`);
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

/** Scheduled dates per employee (time_entries READ — scheduled rows only),
 * paged past PostgREST's 1000-row cap. */
async function scheduledDatesByEmployee(
  supabase: AdminClient,
  employeeIds: string[],
  sinceDate: string,
  untilDate: string
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (employeeIds.length === 0) return out;
  const BATCH = 1000;
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await supabase
      .from("time_entries")
      .select("employee_id, entry_date")
      .in("employee_id", employeeIds)
      .eq("entry_type", "scheduled")
      .gte("entry_date", sinceDate)
      .lte("entry_date", untilDate)
      .order("entry_date", { ascending: true })
      .range(from, from + BATCH - 1);
    if (error) throw new Error(`scheduled dates read: ${error.message}`);
    for (const r of data ?? []) {
      const id = String(r.employee_id);
      const set = out.get(id) ?? new Set<string>();
      set.add(String(r.entry_date).slice(0, 10));
      out.set(id, set);
    }
    if (!data || data.length < BATCH) break;
  }
  return out;
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
  skipped_no_guid: number;
  skipped_no_date: number;
  skipped_no_in: number;
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

  // 3) Behavioural matcher over unmatched guids with punches (§4 path 2).
  //    Punch dates come from ALL stored punches for the guid (not just this
  //    window) so evidence accumulates night over night. TWO-PHASE (Codex
  //    2026-08-23): every guid is scored against the FULL candidate pool
  //    first, then commits happen — so verdicts are order-independent, and
  //    two guids auto-resolving to the SAME employee is itself ambiguity
  //    (both queue) rather than first-wins.
  const mappedEmployeeIds = new Set(existing.values());
  const candidatesRaw = (await employeesAtLocation(supabase, loc.id, true)).filter(
    (c) => !mappedEmployeeIds.has(c.id)
  );
  const unmatchedGuids = await storedUnmatchedPunchDates(supabase, loc.id);
  const schedules = await scheduledDatesByEmployee(
    supabase,
    candidatesRaw.map((c) => c.id),
    loc.labor_start_date,
    untilDate
  );
  const candidates: BehaviouralCandidate[] = candidatesRaw.map((c) => ({
    employee_id: c.id,
    scheduledDates: schedules.get(c.id) ?? new Set<string>(),
  }));

  const verdicts = [...unmatchedGuids.entries()].map(([guid, punchDates]) => ({
    guid,
    verdict: scoreBehaviouralMatch(punchDates, candidates),
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
        evidence: {
          punch_days: verdict.punch_days,
          best_overlap_days: verdict.best.overlap_days,
          runner_up_overlap_days: verdict.runner_up?.overlap_days ?? null,
          min_overlap_threshold: BEHAVIOURAL_MIN_OVERLAP_DAYS,
          runner_up_margin: BEHAVIOURAL_RUNNER_UP_MARGIN,
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
    });
  }

  // 4) Attribution reconciliation — the single writer, from fresh DB truth
  //    (covers email seeds, auto-matches, SA confirms/undos, and any
  //    ignoreDuplicates race above in one idempotent pass).
  await reconcileAttributions(supabase, loc.id);

  // 5) The queue after everything above: unmatched guids that still have
  //    punches. This is what the growth alert and the SA surface watch.
  const remaining = await storedUnmatchedPunchDates(supabase, loc.id);

  return {
    requests,
    entries_pulled: entries.length,
    punches_upserted: upserted,
    email_seeded: plan.seeds.length,
    email_ambiguous: plan.ambiguousEmails,
    auto_matched: autoMatched,
    auto_ambiguous: autoAmbiguous,
    auto_insufficient: autoInsufficient,
    unmatched_queue_size: remaining.size,
    unmatched_toast_employee_guids: [...remaining.keys()].slice(0, 20),
    skipped_no_guid: classified.skippedNoGuid,
    skipped_no_date: classified.skippedNoDate,
    skipped_no_in: classified.skippedNoIn,
  };
}

/** Distinct punch dates per unmatched guid from STORED punches (paged). */
async function storedUnmatchedPunchDates(
  supabase: AdminClient,
  locationId: string
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const BATCH = 1000;
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await supabase
      .from("toast_time_entries")
      .select("toast_employee_guid, entry_date")
      .eq("location_id", locationId)
      .is("employee_id", null)
      .eq("deleted", false)
      .order("entry_date", { ascending: true })
      .range(from, from + BATCH - 1);
    if (error) throw new Error(`unmatched punches read: ${error.message}`);
    for (const r of data ?? []) {
      const guid = String(r.toast_employee_guid);
      const set = out.get(guid) ?? new Set<string>();
      set.add(String(r.entry_date).slice(0, 10));
      out.set(guid, set);
    }
    if (!data || data.length < BATCH) break;
  }
  return out;
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
    rows_in: number;
    rows_upserted: number;
    rows_skipped: number;
    error_text: string | null;
  }>;
}

export interface ToastLaborOptions {
  /** Restrict to one store (location_code). */
  locationCode?: string;
  /** Operator window-start override (YYYY-MM-DD), still floored at each
   * store's go-live. The beat-1 backfill lever passes the floor itself. */
  since?: string;
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
    // Incremental window: high-water mark minus a 2-day re-read margin
    // (late edits to recent punches), floored at go-live; first run (or an
    // operator override) starts at the floor — the backfill IS the first run,
    // the cp_schedule precedent.
    let sinceDate: string;
    if (options.since) {
      sinceDate =
        options.since > loc.labor_start_date ? options.since : loc.labor_start_date;
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
    } catch (err) {
      base.status = "error";
      base.error_text = err instanceof Error ? err.message : String(err);
    }
    await finishRun(supabase, runId, base);
    outcomes.push(base);
    await sleep(REQUEST_DELAY_MS);
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
      rows_in: o.rows_in,
      rows_upserted: o.rows_upserted,
      rows_skipped: o.rows_skipped,
      error_text: o.error_text,
    })),
  };
}
