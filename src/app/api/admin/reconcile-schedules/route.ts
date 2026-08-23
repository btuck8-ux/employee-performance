import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCrosswalk } from "@/lib/ingest/sevenshifts/crosswalk";
import {
  reconcileScheduleSets,
  type CpSourcedDay,
  type DirectShiftRow,
} from "@/lib/ingest/sevenshifts/reconcile";

/**
 * §4-H5 reconciliation: the direct 7shifts shift feed (seven_shifts_shifts,
 * mig 054) vs the CP-sourced scheduled rows in time_entries, same window.
 * READ-ONLY — this is the evidence surface Tucker kept both feeds for, and
 * the measurement CP asked for (their ingest cannot see deletions; ours
 * can, by absence-tombstoning).
 *
 * Reports, per store and per week: days in both · CP-sourced only (largely
 * the deletion-accumulation population — cancelled shifts CP/EPD never
 * removed) · direct-only (rows CP's feed missed) · both-but-tombstoned
 * (vanished upstream since ingest) · attendance_status breakdown for
 * scheduled-unworked days · in_time disagreements > 15 minutes.
 *
 * AUTH: Bearer <CRON_SECRET>.
 *   GET /api/admin/reconcile-schedules?start=YYYY-MM-DD&end=YYYY-MM-DD
 *   (default window: last 28 days through today)
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function pagedSelect<T>(
  query: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string
): Promise<T[]> {
  const out: T[] = [];
  const BATCH = 1000;
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await query(from, from + BATCH - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < BATCH) break;
  }
  return out;
}

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const today = new Date().toISOString().slice(0, 10);
  const defaultStart = new Date(Date.now() - 28 * 86400_000)
    .toISOString()
    .slice(0, 10);
  const start = url.searchParams.get("start") ?? defaultStart;
  const end = url.searchParams.get("end") ?? today;

  try {
    const supabase = createAdminClient();
    const crosswalk = await loadCrosswalk(supabase);
    const codeByLocationId = new Map(
      crosswalk.map((l) => [l.id, l.location_code])
    );

    const direct = await pagedSelect<DirectShiftRow>(
      (from, to) =>
        supabase
          .from("seven_shifts_shifts")
          .select(
            "seven_shifts_shift_id, location_id, employee_id, entry_date, start_at, missing_upstream_since, attendance_status"
          )
          .gte("entry_date", start)
          .lte("entry_date", end)
          .order("seven_shifts_shift_id", { ascending: true })
          .range(from, to),
      "seven_shifts_shifts"
    );

    const cpSourced = await pagedSelect<CpSourcedDay>(
      (from, to) =>
        supabase
          .from("time_entries")
          .select("employee_id, location_id, entry_date, entry_type, in_time")
          .in("entry_type", ["scheduled", "worked"])
          .gte("entry_date", start)
          .lte("entry_date", end)
          .order("id", { ascending: true })
          .range(from, to),
      "time_entries"
    );

    const report = reconcileScheduleSets(direct, cpSourced, codeByLocationId);

    return NextResponse.json({
      reconciliation: "7shifts-direct vs cp-sourced schedules",
      window: { start, end },
      note: "READ-ONLY. Direct feed = seven_shifts_shifts (mig 054); CP-sourced = time_entries entry_type='scheduled'. The metric still reads the CP-sourced rows (§4-H6).",
      ...report,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[reconcile-schedules] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
