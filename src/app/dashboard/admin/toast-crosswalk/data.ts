import "server-only";
import type { AdminClient } from "@/lib/ingest/sevenshifts/crosswalk";
import {
  loadToastLaborLocations,
  fetchToastEmployees,
} from "@/lib/ingest/toast/labor";
import { BEHAVIOURAL_MIN_OVERLAP_DAYS } from "@/lib/ingest/toast/labor-core";

/**
 * Data builders for the SA Toast-crosswalk triage surface (ruling §3/§4).
 * Server-only: Toast credentials and the roster (names/emails) stay on this
 * side of the boundary; the page renders plain values.
 *
 * ⚠️ Names and emails here are DISPLAY HINTS for the SA making the call —
 * nothing in this module (or anywhere in the feed) matches on a name. The
 * overlap hints are schedule-vs-punch day counts, the same independent
 * evidence the auto-matcher scores, shown so the SA sees why a candidate is
 * plausible. Ryan Griffin ≠ Connor Griffin; the human decides.
 */

export interface CandidateOption {
  id: string;
  employee_code: string;
  employee_name: string;
  overlap_days: number;
  /** Mig 057 label — GM punch patterns are expected to be irregular, so a
   * loose-looking overlap on a GM candidate is not necessarily a weak match
   * (the Jose Mena shape). Display only. */
  is_general_manager: boolean;
}

export interface UnmatchedGuidView {
  toast_employee_guid: string;
  location_id: string;
  location_code: string;
  /** From the live Toast roster — display hint only. */
  toast_name: string | null;
  toast_email: string | null;
  toast_deleted: boolean;
  punch_days: number;
  first_punch: string | null;
  last_punch: string | null;
  /** PERMANENTLY STUCK (unmapped-null spec 2026-08-25): below the 6-day
   * auto-commit floor AND idle past the stuck window — it can never
   * accumulate enough overlap for the nightly matcher, so it needs a
   * human, not another night. Distinct from accounts still accruing. */
  stuck: boolean;
  /** All active employees at the store, overlap-sorted — the SA's select. */
  candidates: CandidateOption[];
}

/** The REVERSE check (unmapped-null spec 2026-08-25): the matcher is
 * GUID-first and nothing asked "which scheduled employee has no mapping?"
 * — which is how five people read 0% with their punches sitting in this
 * very queue. An entry here is also the population Build 2 nulls. */
export interface UnmappedScheduledView {
  employee_id: string;
  employee_code: string;
  employee_name: string;
  is_general_manager: boolean;
  location_code: string;
  scheduled_days: number;
  last_scheduled: string | null;
}

export interface RecentMatchView {
  toast_employee_guid: string;
  match_method: string;
  employee_code: string;
  employee_name: string;
  is_general_manager: boolean;
  location_code: string;
  created_at: string;
  evidence: Record<string, unknown> | null;
}

export interface CrosswalkPageData {
  stores: Array<{
    location_code: string;
    crosswalk_rows: number;
    unmatched_with_punches: number;
    roster_error: string | null;
  }>;
  queue: UnmatchedGuidView[];
  unmapped_scheduled: UnmappedScheduledView[];
  recent_matches: RecentMatchView[];
}

/** Idle window for the stuck state: a sub-floor GUID with no punch in this
 * many days will never reach BEHAVIOURAL_MIN_OVERLAP_DAYS on its own.
 * 14 days = two full schedule cycles, conservative against vacations. */
const STUCK_IDLE_DAYS = 14;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function buildCrosswalkPageData(
  supabase: AdminClient
): Promise<CrosswalkPageData> {
  const locations = await loadToastLaborLocations(supabase);
  const queue: UnmatchedGuidView[] = [];
  const unmappedScheduled: UnmappedScheduledView[] = [];
  const stores: CrosswalkPageData["stores"] = [];

  for (const loc of locations) {
    // Crosswalked guids at this store (paged past the PostgREST cap).
    const mappedGuids = new Set<string>();
    const mappedEmployeeIds = new Set<string>();
    const BATCH = 1000;
    for (let from = 0; ; from += BATCH) {
      const { data: xwalk, error: xwalkError } = await supabase
        .from("toast_employee_crosswalk")
        .select("toast_employee_guid, employee_id")
        .eq("location_id", loc.id)
        .order("toast_employee_guid", { ascending: true })
        .range(from, from + BATCH - 1);
      if (xwalkError) throw new Error(`crosswalk read: ${xwalkError.message}`);
      for (const r of xwalk ?? []) {
        mappedGuids.add(String(r.toast_employee_guid));
        mappedEmployeeIds.add(String(r.employee_id));
      }
      if (!xwalk || xwalk.length < BATCH) break;
    }

    // Unmatched punches, grouped per guid (paged).
    const punchDates = new Map<string, Set<string>>();
    for (let from = 0; ; from += BATCH) {
      const { data, error } = await supabase
        .from("toast_time_entries")
        .select("toast_employee_guid, entry_date")
        .eq("location_id", loc.id)
        .is("employee_id", null)
        .eq("deleted", false)
        .order("entry_date", { ascending: true })
        .range(from, from + BATCH - 1);
      if (error) throw new Error(`unmatched punches read: ${error.message}`);
      for (const r of data ?? []) {
        const guid = String(r.toast_employee_guid);
        const set = punchDates.get(guid) ?? new Set<string>();
        set.add(String(r.entry_date).slice(0, 10));
        punchDates.set(guid, set);
      }
      if (!data || data.length < BATCH) break;
    }

    // Candidate pool: active employees at the store (unmapped first via
    // overlap sort below; mapped ones excluded — a second Toast account for
    // a mapped person is exactly the ambiguity the SA resolves by hand, and
    // the select still allows it via the full pool? No: the pool EXCLUDES
    // already-mapped employees so a wrong double-attribution takes deliberate
    // effort — matching the auto-matcher's pool. If a person legitimately
    // needs a second guid, undo the first row and re-confirm both manually.)
    const pool: Array<{
      id: string;
      employee_code: string;
      employee_name: string;
      is_general_manager: boolean;
    }> = [];
    for (let from = 0; ; from += BATCH) {
      const { data: emps, error: empError } = await supabase
        .from("employees")
        .select("id, employee_code, employee_name, is_general_manager")
        .eq("location_id", loc.id)
        .eq("active", true)
        .order("employee_code", { ascending: true })
        .range(from, from + BATCH - 1);
      if (empError) throw new Error(`employees read: ${empError.message}`);
      for (const e of emps ?? []) {
        const id = String(e.id);
        if (!mappedEmployeeIds.has(id)) {
          pool.push({
            id,
            employee_code: e.employee_code as string,
            employee_name: e.employee_name as string,
            is_general_manager: e.is_general_manager === true,
          });
        }
      }
      if (!emps || emps.length < BATCH) break;
    }

    // Scheduled dates for the pool (display-hint overlap). THE FLIP
    // (2026-08-25): the pruned direct feed — the same source the matcher's
    // scheduledStartsByEmployee scores with, so the SA's hint and the
    // auto-matcher's evidence can't disagree (and unpruned time_entries
    // rows can't inflate an overlap hint).
    const schedByEmp = new Map<string, Set<string>>();
    if (pool.length > 0) {
      for (let from = 0; ; from += BATCH) {
        const { data, error } = await supabase
          .from("seven_shifts_shifts")
          .select("employee_id, entry_date")
          .in("employee_id", pool.map((e) => e.id))
          .is("missing_upstream_since", null)
          .eq("deleted", false)
          .eq("draft", false)
          .gte("entry_date", loc.labor_start_date)
          .order("seven_shifts_shift_id", { ascending: true })
          .range(from, from + BATCH - 1);
        if (error) throw new Error(`scheduled read: ${error.message}`);
        for (const r of data ?? []) {
          const id = String(r.employee_id);
          const set = schedByEmp.get(id) ?? new Set<string>();
          set.add(String(r.entry_date).slice(0, 10));
          schedByEmp.set(id, set);
        }
        if (!data || data.length < BATCH) break;
      }
    }

    // Live Toast roster for display hints; a fetch failure degrades to
    // guid-only cards rather than hiding the queue.
    let rosterError: string | null = null;
    const rosterByGuid = new Map<string, { name: string | null; email: string | null; deleted: boolean }>();
    try {
      const roster = await fetchToastEmployees(loc.toast_restaurant_guid);
      for (const te of roster) {
        const guid = str(te.guid);
        if (!guid) continue;
        const first = str(te["firstName"]);
        const last = str(te["lastName"]);
        rosterByGuid.set(guid, {
          name: first || last ? [first, last].filter(Boolean).join(" ") : null,
          email: str(te.email),
          deleted: te.deleted === true,
        });
      }
    } catch (err) {
      rosterError = err instanceof Error ? err.message : String(err);
    }

    for (const [guid, dates] of punchDates) {
      if (mappedGuids.has(guid)) continue;
      const sorted = [...dates].sort();
      const roster = rosterByGuid.get(guid);
      const candidates = pool
        .map((e) => {
          const sched = schedByEmp.get(e.id) ?? new Set<string>();
          let overlap = 0;
          for (const d of dates) if (sched.has(d)) overlap += 1;
          return { ...e, overlap_days: overlap };
        })
        .sort(
          (a, b) =>
            b.overlap_days - a.overlap_days ||
            a.employee_code.localeCompare(b.employee_code)
        );
      const lastPunch = sorted[sorted.length - 1] ?? null;
      const idleDays = lastPunch
        ? Math.floor(
            (Date.now() - new Date(`${lastPunch}T00:00:00Z`).getTime()) / 86400_000
          )
        : null;
      queue.push({
        toast_employee_guid: guid,
        location_id: loc.id,
        location_code: loc.location_code,
        toast_name: roster?.name ?? null,
        toast_email: roster?.email ?? null,
        toast_deleted: roster?.deleted ?? false,
        punch_days: dates.size,
        first_punch: sorted[0] ?? null,
        last_punch: lastPunch,
        stuck:
          dates.size < BEHAVIOURAL_MIN_OVERLAP_DAYS &&
          idleDays !== null &&
          idleDays > STUCK_IDLE_DAYS,
        candidates,
      });
    }

    // THE REVERSE CHECK: unmapped employees with post-go-live scheduled
    // days (from the pruned feed already fetched above). The pool is
    // active-and-unmapped by construction, so this is "pool members with
    // any scheduled day". These are the people Build 2 nulls — they must
    // be visible here, not just silently not-computable.
    for (const e of pool) {
      const days = schedByEmp.get(e.id);
      if (!days || days.size === 0) continue;
      const sortedDays = [...days].sort();
      unmappedScheduled.push({
        employee_id: e.id,
        employee_code: e.employee_code,
        employee_name: e.employee_name,
        is_general_manager: e.is_general_manager,
        location_code: loc.location_code,
        scheduled_days: days.size,
        last_scheduled: sortedDays[sortedDays.length - 1] ?? null,
      });
    }

    stores.push({
      location_code: loc.location_code,
      crosswalk_rows: mappedGuids.size,
      unmatched_with_punches: [...punchDates.keys()].filter((g) => !mappedGuids.has(g))
        .length,
      roster_error: rosterError,
    });
  }

  queue.sort((a, b) => b.punch_days - a.punch_days);

  // Recent matches of EVERY method, undo-able (ruling §4 guard 3 — email
  // seeds are auto-commits too; Codex blocker 2026-08-23: excluding them
  // made a wrong email mapping irreversible from the surface).
  const { data: recent, error: recentError } = await supabase
    .from("toast_employee_crosswalk")
    .select(
      "toast_employee_guid, match_method, evidence, created_at, location_id, employees(employee_code, employee_name, is_general_manager)"
    )
    .order("created_at", { ascending: false })
    .limit(25);
  if (recentError) throw new Error(`recent matches read: ${recentError.message}`);
  const codeByLocId = new Map(locations.map((l) => [l.id, l.location_code]));
  const recentMatches: RecentMatchView[] = (recent ?? []).map((r) => {
    const emp = (Array.isArray(r.employees) ? r.employees[0] : r.employees) as
      | { employee_code: string; employee_name: string; is_general_manager: boolean }
      | null;
    return {
      toast_employee_guid: String(r.toast_employee_guid),
      match_method: String(r.match_method),
      employee_code: emp?.employee_code ?? "?",
      employee_name: emp?.employee_name ?? "?",
      is_general_manager: emp?.is_general_manager === true,
      location_code: codeByLocId.get(String(r.location_id)) ?? "?",
      created_at: String(r.created_at),
      evidence: (r.evidence as Record<string, unknown> | null) ?? null,
    };
  });

  unmappedScheduled.sort((a, b) => b.scheduled_days - a.scheduled_days);
  return {
    stores,
    queue,
    unmapped_scheduled: unmappedScheduled,
    recent_matches: recentMatches,
  };
}
