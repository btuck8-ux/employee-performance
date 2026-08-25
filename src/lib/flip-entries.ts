/**
 * THE FLIP's TS source layer (flip spec 2026-08-24 §3; built 2026-08-25
 * with preconditions cleared): every attendance/punctuality computation
 * builds its TimeEntryRow[] here, never from raw time_entries at a Toast
 * store.
 *
 * Source rules, mirroring the SQL side exactly (TS↔SQL parity):
 *  - WORKED at a Toast store: toast_time_entries (deleted=false, attributed)
 *    on/after the store's own go-live; time_entries worked rows BEFORE the
 *    go-live (pre-Toast history exists only there). This is precisely
 *    v_worked_intervals' go-live split (mig 058).
 *  - SCHEDULED at a Toast store: seven_shifts_shifts, PRUNED
 *    (missing_upstream_since is null, deleted=false, draft=false), one row
 *    per (employee, date) taking the earliest start — the matcher's shape.
 *    STORE+DAY-CONDITIONAL fallback: a date where the direct feed has NO
 *    rows for the store at all (its history floor, or an ingest outage)
 *    falls back to time_entries scheduled rows. On a day the direct feed
 *    DOES cover, it is authoritative: an employee's time_entries scheduled
 *    row with no direct-feed counterpart is the deletion-accumulation
 *    artifact the flip exists to stop counting (139 recovered employee-days
 *    estate-wide). Method rule: the cutover depends on the replacement
 *    being PRESENT for that day, never on a date alone.
 *  - Non-Toast stores (NOLA): time_entries both sides, unchanged.
 *
 * Punctuality semantics change at Toast stores BY DESIGN: scheduled start
 * is the direct feed's start_at and the punch is Toast's in_at, both
 * projected to the store-local wall clock (tz.ts) so the comparison stays
 * like-with-like. The before/after is reported separately in the flip
 * verification.
 *
 * Store config rides v_location_flip_config (definer-rights, mig 058 —
 * explicitly granted to authenticated in mig 061): the profile page calls
 * this under the SESSION client, and a user-tier viewer must resolve their
 * own store's config (locations_read is purview-scoped and empty for the
 * user tier — the 058 Codex blocker's lesson).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TimeEntryRow } from "./performance-recompute";
import {
  timezoneForLocationCode,
  utcToLocalWallClock,
} from "./ingest/sevenshifts/tz";

const BATCH = 1000;

export interface FlipLocationMeta {
  isToast: boolean;
  goLive: string | null;
  tz: string;
}

export async function fetchLocationFlipMeta(
  supabase: SupabaseClient,
  locationId: string
): Promise<FlipLocationMeta> {
  const { data, error } = await supabase
    .from("v_location_flip_config")
    .select("is_toast, go_live, tz")
    .eq("location_id", locationId)
    .maybeSingle();
  if (error) throw new Error(`flip config: ${error.message}`);
  return {
    isToast: data?.is_toast === true,
    goLive: (data?.go_live as string | null) ?? null,
    tz: (data?.tz as string | null) ?? timezoneForLocationCode(""),
  };
}

async function pagedRows<T>(
  build: (from: number, to: number) => PromiseLike<{
    data: unknown[] | null;
    error: { message: string } | null;
  }>,
  label: string
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await build(from, from + BATCH - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < BATCH) break;
  }
  return out;
}

/** Earliest wins per (employee, date); a null time never beats a real one. */
function setEarliest(
  map: Map<string, Map<string, string | null>>,
  employeeId: string,
  date: string,
  localTime: string | null
): void {
  const byDate = map.get(employeeId) ?? new Map<string, string | null>();
  const prev = byDate.get(date);
  if (
    prev === undefined ||
    (localTime !== null && (prev === null || localTime < prev))
  ) {
    byDate.set(date, localTime);
  }
  map.set(employeeId, byDate);
}

export interface FlipSourceRows {
  isToast: boolean;
  goLive: string | null;
  /** Dates where the pruned direct feed has ANY row for the STORE. */
  directFeedDays: Set<string>;
  /** This employee's pruned direct-feed starts, store-local (earliest per date). */
  directStartByDate: Map<string, string | null>;
  /** This employee's Toast punch-ins, store-local (earliest per date). */
  toastInByDate: Map<string, string | null>;
  /** This employee's raw time_entries rows (both entry types). */
  timeEntries: TimeEntryRow[];
}

/**
 * Pure merge: one employee's effective TimeEntryRow[] under the flip rules.
 * Exported for unit tests — this function IS the flip's TS semantics.
 */
export function mergeEffectiveEntries(src: FlipSourceRows): TimeEntryRow[] {
  if (!src.isToast) return src.timeEntries;

  const teScheduled = new Map<string, TimeEntryRow>();
  const teWorked = new Map<string, TimeEntryRow>();
  for (const e of src.timeEntries) {
    if (e.entry_type === "scheduled") teScheduled.set(e.entry_date, e);
    else teWorked.set(e.entry_date, e);
  }

  const out: TimeEntryRow[] = [];
  const dates = new Set<string>([
    ...src.directStartByDate.keys(),
    ...src.toastInByDate.keys(),
    ...teScheduled.keys(),
    ...teWorked.keys(),
  ]);

  for (const date of [...dates].sort()) {
    // SCHEDULED — day-conditional on the STORE's direct-feed coverage.
    if (src.directFeedDays.has(date)) {
      const start = src.directStartByDate.get(date);
      if (start !== undefined) {
        out.push({ entry_date: date, entry_type: "scheduled", in_time: start });
      }
      // No direct shift on a covered day = not scheduled, even if an
      // unpruned time_entries row says otherwise (the artifact).
    } else {
      const te = teScheduled.get(date);
      if (te) out.push(te);
    }

    // WORKED — the go-live split, exactly as v_worked_intervals.
    if (src.goLive !== null && date >= src.goLive) {
      const inAt = src.toastInByDate.get(date);
      if (inAt !== undefined) {
        out.push({ entry_date: date, entry_type: "worked", in_time: inAt });
      }
      // Absence of a Toast punch on/after go-live IS absence — Toast is
      // the actuals (the ruling); a leftover 7shifts worked row does not
      // resurrect the day.
    } else {
      const te = teWorked.get(date);
      if (te) out.push(te);
    }
  }
  return out;
}

/**
 * Fetch + merge for a set of employees at ONE location over an inclusive
 * window (start null = unbounded history, the profile's all-time case).
 * Returns employeeId -> effective TimeEntryRow[].
 */
export async function fetchEffectiveEntries(
  supabase: SupabaseClient,
  locationId: string,
  employeeIds: string[],
  window: { start: string | null; end: string },
  metaIn?: FlipLocationMeta
): Promise<Map<string, TimeEntryRow[]>> {
  const meta = metaIn ?? (await fetchLocationFlipMeta(supabase, locationId));
  const out = new Map<string, TimeEntryRow[]>();
  if (employeeIds.length === 0) return out;

  type TeRow = TimeEntryRow & { employee_id: string };
  const teRows = await pagedRows<TeRow>((from, to) => {
    let q = supabase
      .from("time_entries")
      .select("employee_id, entry_date, entry_type, in_time")
      .eq("location_id", locationId)
      .in("employee_id", employeeIds)
      .lte("entry_date", window.end)
      .order("id", { ascending: true })
      .range(from, to);
    if (window.start) q = q.gte("entry_date", window.start);
    return q;
  }, "flip time_entries");
  const teByEmployee = new Map<string, TimeEntryRow[]>();
  for (const r of teRows) {
    const list = teByEmployee.get(String(r.employee_id)) ?? [];
    list.push({
      entry_date: String(r.entry_date),
      entry_type: r.entry_type,
      in_time: r.in_time ?? null,
    });
    teByEmployee.set(String(r.employee_id), list);
  }

  if (!meta.isToast) {
    for (const id of employeeIds) out.set(id, teByEmployee.get(id) ?? []);
    return out;
  }

  // Store-level direct-feed day coverage (pruned) — the day-conditional set.
  const dayRows = await pagedRows<{ entry_date: string }>((from, to) => {
    let q = supabase
      .from("seven_shifts_shifts")
      .select("entry_date")
      .eq("location_id", locationId)
      .is("missing_upstream_since", null)
      .eq("deleted", false)
      .eq("draft", false)
      .lte("entry_date", window.end)
      .order("seven_shifts_shift_id", { ascending: true })
      .range(from, to);
    if (window.start) q = q.gte("entry_date", window.start);
    return q;
  }, "flip shift days");
  const directFeedDays = new Set(dayRows.map((r) => String(r.entry_date).slice(0, 10)));

  const shiftRows = await pagedRows<{
    employee_id: string;
    entry_date: string;
    start_at: string;
  }>((from, to) => {
    let q = supabase
      .from("seven_shifts_shifts")
      .select("employee_id, entry_date, start_at")
      .eq("location_id", locationId)
      .in("employee_id", employeeIds)
      .is("missing_upstream_since", null)
      .eq("deleted", false)
      .eq("draft", false)
      .lte("entry_date", window.end)
      .order("seven_shifts_shift_id", { ascending: true })
      .range(from, to);
    if (window.start) q = q.gte("entry_date", window.start);
    return q;
  }, "flip shifts");
  const directStarts = new Map<string, Map<string, string | null>>();
  for (const r of shiftRows) {
    setEarliest(
      directStarts,
      String(r.employee_id),
      String(r.entry_date).slice(0, 10),
      utcToLocalWallClock(r.start_at, meta.tz)?.time ?? null
    );
  }

  const punchRows = await pagedRows<{
    employee_id: string;
    entry_date: string;
    in_at: string;
  }>((from, to) => {
    let q = supabase
      .from("toast_time_entries")
      .select("employee_id, entry_date, in_at")
      .eq("location_id", locationId)
      .in("employee_id", employeeIds)
      .eq("deleted", false)
      .lte("entry_date", window.end)
      .order("toast_time_entry_guid", { ascending: true })
      .range(from, to);
    if (window.start) q = q.gte("entry_date", window.start);
    return q;
  }, "flip punches");
  const toastIns = new Map<string, Map<string, string | null>>();
  for (const r of punchRows) {
    setEarliest(
      toastIns,
      String(r.employee_id),
      String(r.entry_date).slice(0, 10),
      utcToLocalWallClock(r.in_at, meta.tz)?.time ?? null
    );
  }

  for (const id of employeeIds) {
    out.set(
      id,
      mergeEffectiveEntries({
        isToast: true,
        goLive: meta.goLive,
        directFeedDays,
        directStartByDate: directStarts.get(id) ?? new Map(),
        toastInByDate: toastIns.get(id) ?? new Map(),
        timeEntries: teByEmployee.get(id) ?? [],
      })
    );
  }
  return out;
}

/**
 * The scheduled-scored-through cap's worked side under the flip: the latest
 * date the store's EFFECTIVE worked source has reached (Toast punches at
 * Toast stores, time_entries worked elsewhere). Null when the source holds
 * nothing yet — callers default to today, as before.
 */
export async function latestEffectiveWorkedDate(
  supabase: SupabaseClient,
  locationId: string,
  metaIn?: FlipLocationMeta
): Promise<string | null> {
  const meta = metaIn ?? (await fetchLocationFlipMeta(supabase, locationId));
  const q = meta.isToast
    ? supabase
        .from("toast_time_entries")
        .select("entry_date")
        .eq("location_id", locationId)
        .eq("deleted", false)
    : supabase
        .from("time_entries")
        .select("entry_date")
        .eq("location_id", locationId)
        .eq("entry_type", "worked");
  const { data, error } = await q
    .order("entry_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`flip worked cap: ${error.message}`);
  return (data?.entry_date as string | undefined)?.slice(0, 10) ?? null;
}
