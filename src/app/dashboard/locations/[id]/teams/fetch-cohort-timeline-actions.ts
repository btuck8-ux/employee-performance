"use server";
import { createClient } from "@/lib/supabase/server";

export interface CohortDailyRow {
  day: string; // YYYY-MM-DD
  cohort_sales: number;
  cohort_tips: number;
  cohort_tip_rate_pct: number | null;
  location_sales: number;
  location_tips: number;
  location_tip_rate_pct: number | null;
}

interface FetchCohortTimelineInput {
  member_ids: string[];
  location_id: string;
  start_date: string;
  end_date: string;
}

/**
 * Server action: fetch the per-day cohort tip rate + location baseline for a
 * specified cohort. Strict co-presence semantics — a sale counts only when
 * EVERY person on shift is in the cohort AND all cohort members are present.
 * That mirrors the team_tip_impact definition so the modal numbers reconcile
 * with the leaderboard row that opened it.
 */
export async function fetchCohortTimelineAction(
  input: FetchCohortTimelineInput
): Promise<
  | { ok: true; rows: CohortDailyRow[] }
  | { ok: false; error: string }
> {
  const { member_ids, location_id, start_date, end_date } = input;
  if (!member_ids?.length || !location_id || !start_date || !end_date) {
    return { ok: false, error: "Missing required parameters" };
  }
  if (start_date > end_date) {
    return { ok: false, error: "start_date must be <= end_date" };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc(
    "compute_cohort_daily_tip_rate",
    {
      p_member_ids: member_ids,
      p_location_id: location_id,
      p_start_date: start_date,
      p_end_date: end_date,
    }
  );
  if (error) {
    console.error("[cohort-timeline] rpc error:", error.message);
    return { ok: false, error: error.message };
  }

  const toNum = (v: number | string | null | undefined): number => {
    if (v === null || v === undefined) return 0;
    const n = typeof v === "string" ? Number(v) : v;
    return Number.isNaN(n) ? 0 : n;
  };
  const toNumOrNull = (v: number | string | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === "string" ? Number(v) : v;
    return Number.isNaN(n) ? null : n;
  };
  type RawRow = {
    day: string;
    cohort_sales: number | string | null;
    cohort_tips: number | string | null;
    cohort_tip_rate_pct: number | string | null;
    location_sales: number | string | null;
    location_tips: number | string | null;
    location_tip_rate_pct: number | string | null;
  };
  const rows: CohortDailyRow[] = ((data ?? []) as RawRow[]).map((r) => ({
    day: r.day,
    cohort_sales: toNum(r.cohort_sales),
    cohort_tips: toNum(r.cohort_tips),
    cohort_tip_rate_pct: toNumOrNull(r.cohort_tip_rate_pct),
    location_sales: toNum(r.location_sales),
    location_tips: toNum(r.location_tips),
    location_tip_rate_pct: toNumOrNull(r.location_tip_rate_pct),
  }));
  return { ok: true, rows };
}
