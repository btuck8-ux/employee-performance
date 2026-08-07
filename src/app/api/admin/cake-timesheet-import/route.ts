import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { nolaLocationId } from "@/lib/ingest/cake/nola-location";
import { startRun, finishRun } from "@/lib/ingest/sevenshifts/runs";
import { ingestCakeTimesheetCsv } from "@/lib/ingest/cake/ingest";

/**
 * CAKE timesheet CSV import — lands NOLA worked actuals into time_entries and
 * recomputes the touched (employee x quarter) performance records.
 *
 * WHY: NOLA's actuals_source is 'cake', so the nightly 7shifts pull skips it.
 * Until the CAKE Labor API feed is live, NOLA labor is loaded from a manual
 * CAKE timesheet export (the staff.cake.net getShifts pull, projected to local
 * Chicago wall-clock, written as cake-nola-timesheets-*.csv). This route is the
 * durable, idempotent loader for that export. API-INDEPENDENT by design.
 *
 * AUTH: Bearer <CRON_SECRET>, mirroring the nightly + backfill routes.
 *
 * BODY: the CSV, sent either as
 *   - a raw text body (Content-Type: text/csv or text/plain), or
 *   - multipart/form-data with a `file` field.
 * Canonical columns: cake_profile_id, business_date (YYYY-MM-DD), clock_in,
 * clock_out, paid_hours, hourly_rate, job_title (+ ignored extras). Common
 * header aliases are accepted.
 *
 * QUERY (optional): ?window_start=YYYY-MM-DD&window_end=YYYY-MM-DD bound which
 * business dates are loaded (inclusive). Omit to load the whole file.
 *
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     -H "Content-Type: text/csv" --data-binary @cake-nola-timesheets.csv \
 *     "$BASE/api/admin/cake-timesheet-import?window_start=2026-06-09&window_end=2026-06-18"
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function readCsv(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (file && typeof file !== "string") return await file.text();
    const csv = form.get("csv");
    if (typeof csv === "string") return csv;
    return "";
  }
  return await request.text();
}

async function nolaMaxDate(
  supabase: ReturnType<typeof createAdminClient>,
  nolaId: string
): Promise<string | null> {
  const { data } = await supabase
    .from("time_entries")
    .select("entry_date")
    .eq("location_id", nolaId)
    .order("entry_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.entry_date as string | undefined) ?? null;
}

export async function POST(request: Request) {
  // Dedicated harvester token (least privilege); falls back to CRON_SECRET so
  // nothing breaks before CAKE_HARVEST_TOKEN is set. Once set, only it is accepted.
  const denied = requireBearer(request, process.env.CAKE_HARVEST_TOKEN ?? process.env.CRON_SECRET, "CAKE_HARVEST_TOKEN/CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const windowStart = (url.searchParams.get("window_start") ?? "").trim() || undefined;
  const windowEnd = (url.searchParams.get("window_end") ?? "").trim() || undefined;

  try {
    const csvText = await readCsv(request);
    if (!csvText.trim()) {
      return NextResponse.json(
        { error: "Empty body. Send the CAKE CSV as text/csv or multipart `file`." },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();
    const nolaId = await nolaLocationId(supabase);
    const maxBefore = await nolaMaxDate(supabase, nolaId);

    const runId = await startRun(
      supabase,
      "cake_timesheets",
      nolaId,
      windowStart ? `${windowStart}T00:00:00-05:00` : null,
      windowEnd ? `${windowEnd}T23:59:59-05:00` : null
    );

    const outcome = await ingestCakeTimesheetCsv(supabase, csvText, { windowStart, windowEnd });

    await finishRun(supabase, runId, {
      status: outcome.status,
      rows_in: outcome.rows_in,
      rows_upserted: outcome.rows_upserted,
      rows_skipped: outcome.rows_skipped,
      detail: outcome.detail,
      error_text: outcome.error_text,
    });

    const maxAfter = await nolaMaxDate(supabase, nolaId);

    return NextResponse.json({
      import: "cake-timesheets",
      window: { start: windowStart ?? null, end: windowEnd ?? null },
      outcome: {
        status: outcome.status,
        rows_in: outcome.rows_in,
        rows_upserted: outcome.rows_upserted,
        rows_skipped: outcome.rows_skipped,
        unmapped_profile_ids: outcome.unmapped_profile_ids,
        error_text: outcome.error_text,
        detail: outcome.detail,
      },
      coverage: { nola_max_entry_date_before: maxBefore, nola_max_entry_date_after: maxAfter },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cake-timesheet-import] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
