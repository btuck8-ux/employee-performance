import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { maybeSendFailureAlert } from "@/lib/ingest/sevenshifts/alert";
import {
  ingestParsedTasksForTargets,
  type TasksTarget,
} from "@/lib/ingest/tasks/ingest-targets";
import { parseTasksCsv } from "@/lib/task-import";

/**
 * 7shifts Tasks-report CSV import — the landing route for the nightly
 * Playwright harness (scripts/7tasks-nightly/, GitHub Actions), mirroring the
 * CAKE nightly's cake-timesheet-import.
 *
 * WHY: the server-side dashboard-cookie tasks pull is retired (the cookie
 * expires in days — see the harvest-guest-feedback cron comment). The durable
 * path logs into app.7shifts.com fresh each run in CI, exports the Tasks
 * report per company (62064 HOU, 185592 the 6 CO stores), and POSTs each CSV
 * here. This route parses once and fans out over every 7Tasks-eligible store
 * via the same shared ingest loop the harvest uses (ingest-targets.ts): the
 * CSV Location column routes stores, upserts + accountability + recompute are
 * identical to the manual TasksReport upload, and each store gets an
 * ingest_runs row (source '7tasks') feeding the failure alert.
 *
 * AUTH: Bearer — a dedicated TASKS_HARVEST_TOKEN if set, else the CAKE
 * harness token (decision 7/27: reuse — same trust boundary), else
 * CRON_SECRET. /api/admin/* is middleware-exempt.
 *
 * BODY: the raw Tasks-report CSV (text/csv, or multipart `file`).
 * QUERY (optional): ?window_start / ?window_end (YYYY-MM-DD) for run-row
 * context; defaults to the CSV's own task_date range.
 *
 *   curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/csv" \
 *     --data-binary @TasksReport.csv "$BASE/api/admin/import-tasks-csv"
 */

export const dynamic = "force-dynamic";
// 7 stores × (task upserts + presence overlap + per-employee recompute); a
// wide backfill window for all stores stays under the ceiling (the manual
// uploads of the same reports ran as single server actions).
export const maxDuration = 300;

/** 7shifts companies with the Tasks module: HOU (62064) + 6 CO (185592). */
const TASKS_COMPANY_IDS = [62064, 185592];

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

export async function POST(request: Request) {
  const secret =
    process.env.TASKS_HARVEST_TOKEN ??
    process.env.CAKE_HARVEST_TOKEN ??
    process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "TASKS_HARVEST_TOKEN/CAKE_HARVEST_TOKEN/CRON_SECRET not configured" },
      { status: 500 }
    );
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const windowStart = (url.searchParams.get("window_start") ?? "").trim();
  const windowEnd = (url.searchParams.get("window_end") ?? "").trim();

  try {
    const csvText = await readCsv(request);
    if (!csvText.trim()) {
      return NextResponse.json(
        { error: "Empty body. Send the Tasks-report CSV as text/csv or multipart `file`." },
        { status: 400 }
      );
    }

    const parsed = parseTasksCsv(csvText);
    if (parsed.tasks.length === 0) {
      return NextResponse.json(
        { import: "7tasks", outcome: "no task rows parsed", warnings: parsed.warnings ?? [] },
        { status: 200 }
      );
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("locations")
      .select("id, name, location_code, csv_aliases, seven_shifts_company_id")
      .in("seven_shifts_company_id", TASKS_COMPANY_IDS)
      .order("location_code");
    if (error) throw new Error(`Failed to load 7Tasks locations: ${error.message}`);
    const targets: TasksTarget[] = (data ?? []).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      location_code: r.location_code as string,
      csv_aliases: (r.csv_aliases as string[] | null) ?? null,
    }));

    // Window context on the run rows: explicit query params, else the CSV's
    // own task_date range (the honest description of what this import holds).
    const dates = parsed.tasks.map((t) => t.task_date).filter(Boolean).sort();
    const startDate = windowStart || dates[0];
    const endIso = windowEnd
      ? `${windowEnd}T23:59:59.000Z`
      : new Date().toISOString();
    const windows = new Map(targets.map((t) => [t.id, `${startDate}T00:00:00.000Z`]));

    const outcomes = await ingestParsedTasksForTargets(
      supabase,
      parsed,
      targets,
      windows,
      endIso
    );
    const alert = await maybeSendFailureAlert(outcomes);

    const byStatus: Record<string, number> = {};
    for (const o of outcomes) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

    return NextResponse.json({
      import: "7tasks",
      window: { start: startDate ?? null, end: endIso },
      csv_rows: parsed.tasks.length,
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
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[import-tasks-csv] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
