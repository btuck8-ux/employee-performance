/**
 * CP reads for the schedule feed: one location's weekly_schedule_entries in a
 * shift_start_at window (kickoff-ui-rbac-c-brand-2026-08-14.md §3).
 *
 * READ-ONLY against CP (same fence as the survey feed's fetch.ts): this feed
 * must never write CP-side. Source table verified live 2026-08-14 (CP ref
 * pkjugezverggrcmfylkf): weekly_schedule_entries carries timestamptz
 * shift_start_at/shift_end_at, role, and — on ~99% of rows — employee_code
 * plus sevenshifts_user_id, which is what the EPD-side resolve keys on.
 *
 * The window filter is on shift_start_at in UTC; the local-date projection
 * happens EPD-side (schedule-resolve.ts). A UTC window is up to a few hours
 * wider than the intended local-date window at the edges — harmless, the
 * upsert grain is idempotent.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CpScheduleRow } from "./schedule-resolve";

const FETCH_PAGE = 1000;

async function fetchAll<T>(
  build: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + FETCH_PAGE - 1);
    if (error) throw new Error(`CP ${label}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < FETCH_PAGE) break;
    from += FETCH_PAGE;
  }
  return out;
}

/**
 * Pull one CP location's schedule rows with shift_start_at inside
 * [sinceDate, untilDate] (YYYY-MM-DD, inclusive, UTC-bounded).
 */
export async function fetchCpScheduleRows(
  cp: SupabaseClient,
  cpLocationId: string,
  sinceDate: string,
  untilDate: string
): Promise<CpScheduleRow[]> {
  return fetchAll<CpScheduleRow>(
    (from, to) =>
      cp
        .from("weekly_schedule_entries")
        .select(
          "id, employee_name, employee_email, shift_start_at, shift_end_at, role, employee_code, sevenshifts_user_id"
        )
        .eq("location_id", cpLocationId)
        .gte("shift_start_at", `${sinceDate}T00:00:00.000Z`)
        .lte("shift_start_at", `${untilDate}T23:59:59.999Z`)
        .order("shift_start_at", { ascending: true })
        .range(from, to),
    "weekly_schedule_entries"
  );
}
