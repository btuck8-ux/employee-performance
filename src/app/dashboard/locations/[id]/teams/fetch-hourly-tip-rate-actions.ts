"use server";
import { createClient } from "@/lib/supabase/server";
import { numOrNull, toNum } from "@/lib/format";

export interface HourlyTipRateRow {
  hour_of_day: number;
  employee_hours_worked: number;
  employee_sales: number;
  employee_tips: number;
  employee_tip_rate_pct: number | null;
  location_sales: number;
  location_tips: number;
  location_tip_rate_pct: number | null;
}

interface FetchHourlyTipRateInput {
  employee_id: string;
  location_id: string;
  start_date: string; // YYYY-MM-DD
  end_date: string;   // YYYY-MM-DD
}

/**
 * Server action: fetch per-hour tip-rate breakdown for one (employee,
 * location, range). Called by the HourlyTipRateChart client component
 * whenever the time window or employee changes.
 *
 * Returns 11 rows (hours 10..20) — even if no data overlaps, the chart still
 * needs a stable x-axis. Numeric columns are normalized to number|null
 * because the postgres driver serializes numerics as strings.
 */
export async function fetchHourlyTipRateAction(
  input: FetchHourlyTipRateInput
): Promise<{ ok: true; rows: HourlyTipRateRow[] } | { ok: false; error: string }> {
  const { employee_id, location_id, start_date, end_date } = input;

  if (!employee_id || !location_id || !start_date || !end_date) {
    return { ok: false, error: "Missing required parameters" };
  }
  if (start_date > end_date) {
    return { ok: false, error: "start_date must be <= end_date" };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc(
    "compute_employee_hourly_tip_rate",
    {
      p_employee_id: employee_id,
      p_location_id: location_id,
      p_start_date: start_date,
      p_end_date: end_date,
    }
  );

  if (error) {
    console.error("[hourly-tip-rate] rpc error:", error.message);
    return { ok: false, error: error.message };
  }

  type RawRow = {
    hour_of_day: number | string;
    employee_hours_worked: number | string | null;
    employee_sales: number | string | null;
    employee_tips: number | string | null;
    employee_tip_rate_pct: number | string | null;
    location_sales: number | string | null;
    location_tips: number | string | null;
    location_tip_rate_pct: number | string | null;
  };


  const rows: HourlyTipRateRow[] = ((data ?? []) as RawRow[]).map((r) => ({
    hour_of_day: Number(r.hour_of_day),
    employee_hours_worked: toNum(r.employee_hours_worked),
    employee_sales: toNum(r.employee_sales),
    employee_tips: toNum(r.employee_tips),
    employee_tip_rate_pct: numOrNull(r.employee_tip_rate_pct),
    location_sales: toNum(r.location_sales),
    location_tips: toNum(r.location_tips),
    location_tip_rate_pct: numOrNull(r.location_tip_rate_pct),
  }));

  return { ok: true, rows };
}
