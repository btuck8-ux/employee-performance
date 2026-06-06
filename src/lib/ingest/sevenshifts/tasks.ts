/**
 * 7tasks (7shifts task module) -> ingest_runs LOG ONLY.
 *
 * IMPORTANT SCOPE DECISION (2026-06-06): the only documented pull endpoint,
 * `task_list_daily_summary`, is AGGREGATE-ONLY — it returns per-task-list
 * completion percentages for a location+day, with NO individual task instances
 * and NO per-employee completion. EPD's `tasks` / `task_accountability` /
 * `task_owners` model requires per-instance rows + completers + shift-overlap
 * to attribute task accountability to employees and feed scores. The summary
 * cannot populate that model without fabricating attribution data, which would
 * corrupt accountability and every score derived from it.
 *
 * So the nightly task source FETCHES the summary and LOGS the rollup into
 * ingest_runs.detail (per CO location, status success/empty) — nothing is
 * silently dropped, runs stay green — but it does NOT write to the tasks table.
 * Per-employee task attribution that feeds scores remains a fast-follow,
 * pending verification of a per-task detail endpoint with a live token (the
 * open item in phase-11-research-and-decisions-2026-06-05.md).
 *
 * 7tasks is the Colorado program (company 185592) only; the orchestrator does
 * not call this for NOLA or Houston.
 */

import { getOne } from "./client";
import { utcToLocalWallClock, timezoneForLocationCode } from "./tz";
import type { LocationCrosswalk } from "./crosswalk";
import type { RunOutcome } from "./runs";

interface TaskListItem {
  title?: string;
  completion_status?: string;
  total_tasks_completed?: number;
  total_tasks?: number;
  completion_percentage?: number;
}

interface TaskListDailySummary {
  total_completed_percentage?: number;
  total_in_progress_percentage?: number;
  total_incomplete_percentage?: number;
  date?: string;
  task_lists?: TaskListItem[];
}

/** Inclusive local-date range [startDate, endDate], capped at maxDays. */
function localDateRange(
  windowStart: string,
  windowEnd: string,
  tz: string,
  maxDays: number
): string[] {
  const startLocal = utcToLocalWallClock(windowStart, tz);
  const endLocal = utcToLocalWallClock(windowEnd, tz);
  if (!startLocal || !endLocal) return [];
  const out: string[] = [];
  // Iterate by calendar day on the local date strings.
  const cur = new Date(startLocal.date + "T12:00:00Z");
  const end = new Date(endLocal.date + "T12:00:00Z");
  while (cur <= end && out.length < maxDays) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export async function ingestTaskSummaries(
  loc: LocationCrosswalk,
  windowStart: string,
  windowEnd: string
): Promise<RunOutcome> {
  const base: RunOutcome = {
    source: "7tasks",
    location_id: loc.id,
    location_code: loc.location_code,
    status: "running",
    rows_in: 0,
    rows_upserted: 0, // log-only source: never writes the tasks table
    rows_skipped: 0,
    detail: null,
    error_text: null,
    window_start: windowStart,
    window_end: windowEnd,
  };

  try {
    const tz = timezoneForLocationCode(loc.location_code);
    const dates = localDateRange(windowStart, windowEnd, tz, 14);

    const daily: Array<{
      date: string;
      total_completed_pct: number | null;
      lists: Array<{ title: string; completed: number; total: number; pct: number | null }>;
    }> = [];

    for (const date of dates) {
      const summary = await getOne<TaskListDailySummary>(
        loc.company_id,
        "task_list_daily_summary",
        { location_id: loc.seven_shifts_location_id, date }
      );
      if (!summary) continue;
      const lists = (summary.task_lists ?? []).map((l) => ({
        title: l.title ?? "(untitled)",
        completed: l.total_tasks_completed ?? 0,
        total: l.total_tasks ?? 0,
        pct: l.completion_percentage ?? null,
      }));
      daily.push({
        date,
        total_completed_pct: summary.total_completed_percentage ?? null,
        lists,
      });
    }

    base.rows_in = daily.length;
    const anyTasks = daily.some((d) => d.lists.some((l) => l.total > 0));
    base.detail = {
      note: "log-only: task_list_daily_summary is aggregate; not written to tasks table (see tasks.ts header)",
      days_fetched: daily.length,
      daily,
    };
    base.status = anyTasks ? "success" : "empty";
    return base;
  } catch (err) {
    base.status = "error";
    base.error_text = err instanceof Error ? err.message : String(err);
    return base;
  }
}
