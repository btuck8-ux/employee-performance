"use server";
import { createClient } from "@/lib/supabase/server";
import {
  computeLocationCsScoreTimeSeries,
  computeMultiLocationCsScoreForQuarter,
  type LocationCsScore,
} from "@/lib/location-cs-score";

interface FetchTimeSeriesInput {
  location_id: string;
}

interface FetchMultiLocationInput {
  report_period_id: string;
}

type ActionResult<T> =
  | { ok: true; rows: T }
  | { ok: false; error: string };

/**
 * Time series for the CS Trend tab — every quarter this location has any
 * performance_records for, chronologically ascending, each tagged with the
 * threshold band.
 */
export async function fetchCsTrendTimeSeries(
  input: FetchTimeSeriesInput
): Promise<ActionResult<LocationCsScore[]>> {
  const { location_id } = input;
  if (!location_id) return { ok: false, error: "Missing location_id" };

  const supabase = await createClient();

  const { data: loc, error: locErr } = await supabase
    .from("locations")
    .select("name")
    .eq("id", location_id)
    .maybeSingle();
  if (locErr) {
    console.error("[cs-trend/time-series] location lookup error:", locErr.message);
    return { ok: false, error: locErr.message };
  }
  if (!loc) return { ok: false, error: "Location not found" };

  try {
    const rows = await computeLocationCsScoreTimeSeries(
      supabase,
      location_id,
      loc.name as string
    );
    return { ok: true, rows };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cs-trend/time-series] rpc error:", msg);
    return { ok: false, error: msg };
  }
}

/**
 * Multi-location snapshot — every active location's CS Score for the chosen
 * quarter, ranked by score desc (NULLs last), each tagged with the threshold
 * band.
 */
export async function fetchCsTrendMultiLocation(
  input: FetchMultiLocationInput
): Promise<ActionResult<LocationCsScore[]>> {
  const { report_period_id } = input;
  if (!report_period_id) {
    return { ok: false, error: "Missing report_period_id" };
  }

  const supabase = await createClient();

  const { data: period, error: periodErr } = await supabase
    .from("report_periods")
    .select("label, period_start, period_end")
    .eq("id", report_period_id)
    .maybeSingle();
  if (periodErr) {
    console.error("[cs-trend/multi-loc] period lookup error:", periodErr.message);
    return { ok: false, error: periodErr.message };
  }
  if (!period) return { ok: false, error: "Quarter not found" };

  try {
    const rows = await computeMultiLocationCsScoreForQuarter(
      supabase,
      report_period_id,
      period.label as string,
      period.period_start as string,
      period.period_end as string
    );
    return { ok: true, rows };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cs-trend/multi-loc] rpc error:", msg);
    return { ok: false, error: msg };
  }
}
