import Papa from "papaparse";

interface RawRow {
  "Start Date"?: string;
  "Start Time"?: string;
  "Due Date"?: string;
  "Due Time"?: string;
  "Time Frame End"?: string;
  Timezone?: string;
  Location?: string;
  "Task List"?: string;
  "List Recurrence"?: string;
  Task?: string;
  "Task Type"?: string;
  Completion?: string;
  Status?: string;
  "Task Assignment (Department)"?: string;
  "Task Assignment (Role)"?: string;
  "Task Assignment (Employee)"?: string;
  "Task Tagged (Employee)"?: string;
  "Completed By"?: string;
  "Time Completed"?: string;
}

export interface ParsedTask {
  task_list_name: string;
  task_name: string;
  task_date: string;        // YYYY-MM-DD
  start_time: string | null; // HH:MM:SS
  due_time: string | null;
  task_type: string | null;
  recurrence: string | null;
  is_complete: boolean;
  earliest_completion_at: string | null; // ISO
  latest_completion_at: string | null;
  completers: string[];      // distinct names from "Completed By"
  /** Captured Location value from the row, for cross-location filtering. */
  location_label: string | null;
}

export interface TaskImportResult {
  rows_in_file: number;
  unique_tasks: number;
  warnings: string[];
  errors: string[];
  tasks: ParsedTask[];
}

function clean(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

function isoDate(s: string | undefined): string | null {
  const c = clean(s);
  if (!c) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(c)) return c;
  const m = c.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

/** "10:00:00" or "10:00 AM" → "HH:MM:SS" 24h. */
function isoTime(s: string | undefined): string | null {
  const c = clean(s);
  if (!c) return null;
  const m24 = c.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const min = parseInt(m24[2], 10);
    const sec = m24[3] ? parseInt(m24[3], 10) : 0;
    if (h <= 23 && min <= 59 && sec <= 59) {
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    }
  }
  const mAmPm = c.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (mAmPm) {
    let h = parseInt(mAmPm[1], 10);
    const min = parseInt(mAmPm[2], 10);
    if (mAmPm[3].toUpperCase() === "PM" && h !== 12) h += 12;
    if (mAmPm[3].toUpperCase() === "AM" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
  }
  return null;
}

/** "2026-01-23 19:19:49" → "2026-01-23T19:19:49" */
function isoDatetime(s: string | undefined): string | null {
  const c = clean(s);
  if (!c) return null;
  const m = c.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  if (m) return `${m[1]}T${m[2]}`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(c)) return c;
  return null;
}

export function parseTasksCsv(csvText: string): TaskImportResult {
  const result: TaskImportResult = {
    rows_in_file: 0,
    unique_tasks: 0,
    warnings: [],
    errors: [],
    tasks: [],
  };

  const parsed = Papa.parse<RawRow>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) {
      result.errors.push(`Row ${err.row ?? "?"}: ${err.message}`);
    }
  }

  const rows = parsed.data;
  result.rows_in_file = rows.length;
  if (rows.length === 0) {
    result.errors.push("CSV is empty.");
    return result;
  }

  const groups = new Map<string, ParsedTask>();
  let skippedNoDate = 0;

  for (const row of rows) {
    const taskList = clean(row["Task List"]);
    const taskName = clean(row["Task"]);
    const startDate = isoDate(row["Start Date"]);
    const startTime = isoTime(row["Start Time"]);
    if (!taskList || !taskName || !startDate) {
      skippedNoDate += 1;
      continue;
    }

    const key = `${taskList.toLowerCase()}|${taskName.toLowerCase()}|${startDate}|${startTime ?? ""}`;
    const completion = (clean(row.Completion) ?? "").toLowerCase();
    const isCompleteRow = completion === "complete";
    const completedAt = isoDatetime(row["Time Completed"]);
    const completer = clean(row["Completed By"]);

    let task = groups.get(key);
    if (!task) {
      task = {
        task_list_name: taskList,
        task_name: taskName,
        task_date: startDate,
        start_time: startTime,
        due_time: isoTime(row["Due Time"]),
        task_type: clean(row["Task Type"]),
        recurrence: clean(row["List Recurrence"]),
        is_complete: false,
        earliest_completion_at: null,
        latest_completion_at: null,
        completers: [],
        location_label: clean(row.Location),
      };
      groups.set(key, task);
    } else if (!task.location_label) {
      task.location_label = clean(row.Location);
    }

    if (isCompleteRow) {
      task.is_complete = true;
      if (completedAt) {
        if (!task.earliest_completion_at || completedAt < task.earliest_completion_at) {
          task.earliest_completion_at = completedAt;
        }
        if (!task.latest_completion_at || completedAt > task.latest_completion_at) {
          task.latest_completion_at = completedAt;
        }
      }
      if (completer && !task.completers.includes(completer)) {
        task.completers.push(completer);
      }
    }
  }

  if (skippedNoDate > 0) {
    result.warnings.push(`Skipped ${skippedNoDate} rows missing required fields (Task List / Task / Start Date).`);
  }

  result.tasks = Array.from(groups.values());
  result.unique_tasks = result.tasks.length;
  return result;
}
