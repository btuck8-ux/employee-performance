/**
 * 7Tasks via the PUBLIC 7shifts API (token auth — no browser, no Cloudflare).
 *
 * Step 0 probe (2026-07-27, both companies live): GET /v2/company/{id}/
 * task_lists?active_on_date=YYYY-MM-DD&location_id=… returns each task-list
 * instance WITH its tasks embedded, and each task carries `user_id` +
 * `completed_at` (per-task completion attributed to a 7shifts user). That is
 * the whole grain the browser harness scraped — so this source replaces the
 * dashboard export with a plain authenticated pull on the same client the
 * labor feed uses (tokenForCompany / x-api-version 2025-03-01 / paging).
 *
 * Identity is CROSSWALK-FIRST: completions resolve 7shifts user_id → EPD
 * employee via employees.seven_shifts_user_id (the labor feed's crosswalk),
 * and stores route by locations.seven_shifts_location_id — no CSV
 * location_label string-matching, no fuzzy names as a primary key. The
 * resolved rows are then shaped as ParsedTask and fed through the SAME
 * ingestParsedTasksForTargets compute the CSV/harness path uses (location
 * label = the exact EPD location name; completers = resolved roster names,
 * which hit the matcher's exact stage) — one tasks compute path, zero
 * duplication. An unresolved user_id becomes a `7shifts:<id>` placeholder
 * that surfaces in ownership_unmatched instead of being silently dropped.
 *
 * Known deltas vs the CSV export (informational columns only, not scoring):
 * `recurrence` is not exposed here (upserts null it) and `task_type` maps
 * from the API enum (CHECKMARK → Checkmark).
 */

import { getAll } from "../sevenshifts/client.ts";
import type { AdminClient } from "../sevenshifts/crosswalk";
import type { ParsedTask, TaskImportResult } from "@/lib/task-import";

interface ApiTask {
  id?: number;
  title?: string | null;
  user_id?: number | null;
  completed_at?: string | null; // ISO with the store's local offset
  task_completion?: { type?: string | null } | null;
}

export interface ApiTaskList {
  id?: number;
  title?: string | null;
  start?: string | null; // ISO with local offset
  due?: string | null;
  tasks?: ApiTask[] | null;
}

export interface ApiTasksTarget {
  /** EPD locations.id */
  id: string;
  /** EPD locations.name — becomes ParsedTask.location_label (exact match). */
  name: string;
  seven_shifts_location_id: number;
}

/** Spacer between task_lists calls; getAll only throttles its own pages. */
const CALL_DELAY_MS = 150;
/** Runaway guard on the date fan-out (backfills run per store anyway). */
const MAX_DATES_PER_CALL = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** CHECKMARK -> Checkmark (parity with the CSV export's Task Type column). */
function titleCaseType(t: string | null | undefined): string | null {
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** "2026-07-25T13:43:59-05:00" -> local wall-clock parts. */
function localDate(iso: string | null | undefined): string | null {
  return iso && iso.length >= 10 ? iso.slice(0, 10) : null;
}
function localTime(iso: string | null | undefined): string | null {
  return iso && iso.length >= 19 ? iso.slice(11, 19) : null;
}
function localDateTime(iso: string | null | undefined): string | null {
  return iso && iso.length >= 19 ? `${iso.slice(0, 10)}T${iso.slice(11, 19)}` : null;
}

export function enumerateDates(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  while (cursor <= end && out.length < MAX_DATES_PER_CALL) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Flatten one store's task-list instances into merged ParsedTask rows.
 * The tasks upsert keys on (location, list, task, date, start_time) and a
 * list can repeat a task title (e.g. three "Sweep Kitchen Line" rows), so
 * same-key tasks MERGE: complete if any instance is complete, completion
 * window widened, completers unioned — mirroring the CSV parser's dedupe
 * (a same-key duplicate inside one upsert batch would error in Postgres).
 */
export function mapApiListsToParsedTasks(
  lists: ApiTaskList[],
  locationLabel: string,
  nameForUser: (userId: number) => string | null
): ParsedTask[] {
  const merged = new Map<string, ParsedTask>();

  for (const list of lists) {
    const listName = (list.title ?? "").trim();
    const taskDate = localDate(list.start);
    if (!listName || !taskDate) continue;
    const startTime = localTime(list.start);
    const dueTime = localTime(list.due);

    for (const task of list.tasks ?? []) {
      const taskName = (task.title ?? "").trim();
      if (!taskName) continue;
      const key = `${listName.toLowerCase()}|${taskName.toLowerCase()}|${taskDate}|${startTime ?? ""}`;

      const completedAt = localDateTime(task.completed_at);
      const completer =
        task.completed_at && task.user_id != null
          ? (nameForUser(task.user_id) ?? `7shifts:${task.user_id}`)
          : null;

      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          task_list_name: listName,
          task_name: taskName,
          task_date: taskDate,
          start_time: startTime,
          due_time: dueTime,
          task_type: titleCaseType(task.task_completion?.type),
          recurrence: null,
          is_complete: task.completed_at != null,
          earliest_completion_at: completedAt,
          latest_completion_at: completedAt,
          completers: completer ? [completer] : [],
          location_label: locationLabel,
        });
      } else {
        if (task.completed_at != null) existing.is_complete = true;
        if (completedAt) {
          if (!existing.earliest_completion_at || completedAt < existing.earliest_completion_at) {
            existing.earliest_completion_at = completedAt;
          }
          if (!existing.latest_completion_at || completedAt > existing.latest_completion_at) {
            existing.latest_completion_at = completedAt;
          }
        }
        if (completer && !existing.completers.includes(completer)) {
          existing.completers.push(completer);
        }
      }
    }
  }
  return Array.from(merged.values());
}

/**
 * Pull [startDate, endDate] of task lists for one company's stores and shape
 * them as a TaskImportResult for ingestParsedTasksForTargets. One
 * active_on_date × store call per day (embedded tasks — no detail calls).
 */
export async function fetchTasksViaApi(
  supabase: AdminClient,
  companyId: number,
  targets: ApiTasksTarget[],
  startDate: string,
  endDate: string
): Promise<TaskImportResult> {
  // user_id -> employee_name crosswalk (the labor feed's identity spine).
  const { data: emps, error } = await supabase
    .from("employees")
    .select("employee_name, seven_shifts_user_id")
    .in("location_id", targets.map((t) => t.id))
    .not("seven_shifts_user_id", "is", null);
  if (error) throw new Error(`employees crosswalk load: ${error.message}`);
  const nameByUserId = new Map<number, string>(
    (emps ?? []).map((e) => [Number(e.seven_shifts_user_id), e.employee_name as string])
  );

  const dates = enumerateDates(startDate, endDate);
  const tasks: ParsedTask[] = [];
  let apiTaskRows = 0;
  const unresolved = new Set<number>();
  const nameForUser = (userId: number): string | null => {
    const name = nameByUserId.get(userId) ?? null;
    if (!name) unresolved.add(userId);
    return name;
  };

  for (const target of targets) {
    for (const date of dates) {
      const lists = await getAll<ApiTaskList>(companyId, "task_lists", {
        active_on_date: date,
        location_id: target.seven_shifts_location_id,
      });
      apiTaskRows += lists.reduce((n, l) => n + (l.tasks?.length ?? 0), 0);
      tasks.push(...mapApiListsToParsedTasks(lists, target.name, nameForUser));
      await sleep(CALL_DELAY_MS);
    }
  }

  const warnings: string[] = [];
  if (unresolved.size > 0) {
    warnings.push(
      `unresolved seven_shifts_user_ids: ${Array.from(unresolved).slice(0, 20).join(", ")}`
    );
  }

  return {
    rows_in_file: apiTaskRows,
    unique_tasks: tasks.length,
    warnings,
    errors: [],
    tasks,
  };
}
