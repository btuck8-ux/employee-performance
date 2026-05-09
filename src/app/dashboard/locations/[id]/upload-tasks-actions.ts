"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseTasksCsv, type ParsedTask } from "@/lib/task-import";
import { recomputePerformanceForQuarter } from "@/lib/performance-recompute";
import { quarterOfDate, type Quarter } from "@/lib/quarter";
import { fuzzyMatchEmployee, type EmployeeCandidate } from "@/lib/fuzzy-match-employee";
import { rowMatchesLocation } from "@/lib/location-match";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

const UPSERT_BATCH_SIZE = 500;
const MIN_OVERLAP_MINUTES = 60; // >= 1 hour overlap = accountable

interface ImportSummary {
  tasks_inserted: number;
  tasks_updated: number;
  tasks_complete: number;
  tasks_incomplete: number;
  accountability_rows: number;
  ownership_rows: number;
  ownership_unmatched: Set<string>;
  warnings: string[];
  failures: string[];
}

function timeToSec(t: string | null): number | null {
  if (!t) return null;
  const m = t.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
}

async function chunkOp<T>(
  fn: (batch: T[]) => Promise<{ error: { message: string } | null }>,
  rows: T[],
  label: string,
  summary: ImportSummary
) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await fn(batch);
    if (error) {
      const msg = `${label} batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}: ${error.message}`;
      console.error("[task-import]", msg);
      summary.failures.push(msg);
    }
  }
}

export async function uploadTasksCsvAction(formData: FormData) {
  console.log("[task-import] uploadTasksCsvAction invoked");

  const location_id = String(formData.get("location_id") ?? "");
  const file = formData.get("file") as File | null;

  if (!location_id) {
    redirect(`/dashboard/locations?task_error=${encodeURIComponent("Missing location.")}`);
  }
  if (!file || file.size === 0) {
    redirect(
      `/dashboard/locations/${location_id}?task_error=${encodeURIComponent("No file uploaded.")}`
    );
  }

  const supabase = await createClient();
  const text = await file.text();
  const parsed = parseTasksCsv(text);
  console.log(
    `[task-import] parsed ${parsed.rows_in_file} rows -> ${parsed.unique_tasks} unique task instances`
  );
  if (parsed.errors.length > 0 && parsed.tasks.length === 0) {
    redirect(
      `/dashboard/locations/${location_id}?task_error=${encodeURIComponent(
        parsed.errors.join("; ")
      )}`
    );
  }

  // Filter out tasks tagged for other locations.
  const { data: locRow } = await supabase
    .from("locations")
    .select("name")
    .eq("id", location_id)
    .single();
  const targetLocationName = (locRow?.name as string | undefined) ?? "";
  const beforeFilter = parsed.tasks.length;
  parsed.tasks = parsed.tasks.filter((t) =>
    rowMatchesLocation(t.location_label, targetLocationName)
  );
  const taskSkippedOtherLocation = beforeFilter - parsed.tasks.length;
  if (taskSkippedOtherLocation > 0) {
    console.log(
      `[task-import] filtered out ${taskSkippedOtherLocation} tasks tagged for other locations`
    );
  }

  const summary: ImportSummary = {
    tasks_inserted: 0,
    tasks_updated: 0,
    tasks_complete: 0,
    tasks_incomplete: 0,
    accountability_rows: 0,
    ownership_rows: 0,
    ownership_unmatched: new Set(),
    warnings: parsed.warnings.slice(0, 10),
    failures: [],
  };

  // ---- Phase 1: bulk upsert tasks ----
  const { data: existingTasks } = await supabase
    .from("tasks")
    .select("id, task_list_name, task_name, task_date, start_time")
    .eq("location_id", location_id)
    .range(0, 99999);
  const existingKey = new Map<string, string>();
  for (const t of existingTasks ?? []) {
    const k = `${(t.task_list_name as string).toLowerCase()}|${(t.task_name as string).toLowerCase()}|${t.task_date}|${(t.start_time as string | null) ?? ""}`;
    existingKey.set(k, t.id);
  }

  const taskPayloads = parsed.tasks.map((t: ParsedTask) => {
    const key = `${t.task_list_name.toLowerCase()}|${t.task_name.toLowerCase()}|${t.task_date}|${t.start_time ?? ""}`;
    if (existingKey.has(key)) summary.tasks_updated += 1;
    else summary.tasks_inserted += 1;
    if (t.is_complete) summary.tasks_complete += 1;
    else summary.tasks_incomplete += 1;
    return {
      location_id,
      task_list_name: t.task_list_name,
      task_name: t.task_name,
      task_date: t.task_date,
      start_time: t.start_time,
      due_time: t.due_time,
      task_type: t.task_type,
      recurrence: t.recurrence,
      is_complete: t.is_complete,
      earliest_completion_at: t.earliest_completion_at,
      latest_completion_at: t.latest_completion_at,
      raw_completers: t.completers.length > 0 ? t.completers : null,
    };
  });

  await chunkOp(
    async (batch: typeof taskPayloads) =>
      await supabase
        .from("tasks")
        .upsert(batch, {
          onConflict: "location_id,task_list_name,task_name,task_date,start_time",
        }),
    taskPayloads,
    "tasks",
    summary
  );

  // Resolve task IDs (including newly inserted)
  const { data: nowTasks } = await supabase
    .from("tasks")
    .select("id, task_list_name, task_name, task_date, start_time, due_time")
    .eq("location_id", location_id)
    .range(0, 99999);
  const taskByKey = new Map<
    string,
    { id: string; date: string; start: string | null; due: string | null }
  >();
  for (const t of nowTasks ?? []) {
    const k = `${(t.task_list_name as string).toLowerCase()}|${(t.task_name as string).toLowerCase()}|${t.task_date}|${(t.start_time as string | null) ?? ""}`;
    taskByKey.set(k, {
      id: t.id as string,
      date: t.task_date as string,
      start: t.start_time as string | null,
      due: t.due_time as string | null,
    });
  }

  // ---- Phase 2: compute accountability ----
  // Pull worked time_entries for the date range we're touching, plus active employees
  const dates = Array.from(new Set(parsed.tasks.map((t) => t.task_date)));
  if (dates.length === 0) {
    redirect(`/dashboard/locations/${location_id}?task_error=No+task+dates+parsed.`);
  }
  const minDate = dates.reduce((a, b) => (a < b ? a : b));
  const maxDate = dates.reduce((a, b) => (a > b ? a : b));

  const { data: worked } = await supabase
    .from("time_entries")
    .select("employee_id, entry_date, in_time, out_time")
    .eq("location_id", location_id)
    .eq("entry_type", "worked")
    .gte("entry_date", minDate)
    .lte("entry_date", maxDate)
    .range(0, 99999);

  const { data: activeEmps } = await supabase
    .from("employees")
    .select("id, employee_name, active")
    .eq("location_id", location_id)
    .eq("active", true);
  const activeSet = new Set((activeEmps ?? []).map((e) => e.id as string));
  const candidates: EmployeeCandidate[] = (activeEmps ?? []).map((e) => ({
    id: e.id as string,
    employee_name: e.employee_name as string,
  }));

  const workedByDate = new Map<
    string,
    { employee_id: string; in: number | null; out: number | null }[]
  >();
  for (const e of worked ?? []) {
    if (!activeSet.has(e.employee_id as string)) continue;
    const list = workedByDate.get(e.entry_date as string);
    const item = {
      employee_id: e.employee_id as string,
      in: timeToSec(e.in_time as string | null),
      out: timeToSec(e.out_time as string | null),
    };
    if (list) list.push(item);
    else workedByDate.set(e.entry_date as string, [item]);
  }

  const accountabilityPayloads: Array<{
    task_id: string;
    employee_id: string;
    overlap_minutes: number;
  }> = [];
  const ownershipPayloads: Array<{
    task_id: string;
    employee_id: string;
    matched_name: string;
    match_confidence: string;
  }> = [];
  const affectedKeys = new Set<string>(); // employee_id|year|quarter

  // Cache fuzzy-match results by typed name (within this location's roster)
  const ownerMatchCache = new Map<
    string,
    { id: string; confidence: string } | null
  >();
  function resolveOwner(typedName: string): { id: string; confidence: string } | null {
    if (ownerMatchCache.has(typedName)) return ownerMatchCache.get(typedName) ?? null;
    const result = fuzzyMatchEmployee(typedName, candidates);
    const out = result.match
      ? { id: result.match.id, confidence: result.confidence }
      : null;
    ownerMatchCache.set(typedName, out);
    if (!out) summary.ownership_unmatched.add(typedName);
    return out;
  }

  for (const t of parsed.tasks) {
    const key = `${t.task_list_name.toLowerCase()}|${t.task_name.toLowerCase()}|${t.task_date}|${t.start_time ?? ""}`;
    const ref = taskByKey.get(key);
    if (!ref) continue;

    const tStart = timeToSec(ref.start);
    const tDue = timeToSec(ref.due);
    if (tStart === null || tDue === null || tDue <= tStart) continue;

    const dayShifts = workedByDate.get(t.task_date) ?? [];
    for (const s of dayShifts) {
      if (s.in === null || s.out === null) continue;
      // Overnight shift: out_time < in_time means the shift wraps past
      // midnight (e.g. 12:55 PM in, 3:55 AM out next day). Without this
      // adjustment, the overlap math collapses to a negative window and
      // closing-shift workers don't get credited for accountability.
      const shiftIn = s.in;
      const shiftOut = s.out < s.in ? s.out + 86400 : s.out;
      const overlapStart = Math.max(shiftIn, tStart);
      const overlapEnd = Math.min(shiftOut, tDue);
      const overlapMin = Math.floor((overlapEnd - overlapStart) / 60);
      if (overlapMin >= MIN_OVERLAP_MINUTES) {
        accountabilityPayloads.push({
          task_id: ref.id,
          employee_id: s.employee_id,
          overlap_minutes: overlapMin,
        });
        const q = quarterOfDate(new Date(t.task_date + "T12:00:00"));
        affectedKeys.add(`${s.employee_id}|${q.year}|${q.quarter}`);
      }
    }

    // Build ownership rows from the parsed completers (deduped within this task)
    if (t.is_complete && t.completers.length > 0) {
      const seenForThisTask = new Set<string>();
      for (const name of t.completers) {
        const owner = resolveOwner(name);
        if (!owner) continue;
        if (seenForThisTask.has(owner.id)) continue;
        seenForThisTask.add(owner.id);
        ownershipPayloads.push({
          task_id: ref.id,
          employee_id: owner.id,
          matched_name: name,
          match_confidence: owner.confidence,
        });
        // Even if they weren't accountable, owning a task still affects metrics.
        const q = quarterOfDate(new Date(t.task_date + "T12:00:00"));
        affectedKeys.add(`${owner.id}|${q.year}|${q.quarter}`);
      }
    }
  }

  // Replace accountability ONLY for the tasks in THIS upload (not every task
  // at the location). Otherwise a sequential month-by-month upload wipes
  // earlier months' accountability when the next month is uploaded.
  const importedTaskIds = parsed.tasks
    .map((t) => {
      const k = `${t.task_list_name.toLowerCase()}|${t.task_name.toLowerCase()}|${t.task_date}|${t.start_time ?? ""}`;
      return taskByKey.get(k)?.id;
    })
    .filter((x): x is string => Boolean(x));
  if (importedTaskIds.length > 0) {
    for (let i = 0; i < importedTaskIds.length; i += 500) {
      const chunk = importedTaskIds.slice(i, i + 500);
      const { error: delErr } = await supabase
        .from("task_accountability")
        .delete()
        .in("task_id", chunk);
      if (delErr) summary.failures.push(`delete accountability: ${delErr.message}`);
    }
  }

  await chunkOp(
    async (batch: typeof accountabilityPayloads) =>
      await supabase.from("task_accountability").insert(batch),
    accountabilityPayloads,
    "task_accountability",
    summary
  );
  summary.accountability_rows = accountabilityPayloads.length;

  // Replace task_owners for the imported tasks (clean slate per task)
  if (importedTaskIds.length > 0) {
    for (let i = 0; i < importedTaskIds.length; i += 500) {
      const chunk = importedTaskIds.slice(i, i + 500);
      const { error: delErr } = await supabase
        .from("task_owners")
        .delete()
        .in("task_id", chunk);
      if (delErr) summary.failures.push(`delete task_owners: ${delErr.message}`);
    }
  }
  await chunkOp(
    async (batch: typeof ownershipPayloads) =>
      await supabase.from("task_owners").insert(batch),
    ownershipPayloads,
    "task_owners",
    summary
  );
  summary.ownership_rows = ownershipPayloads.length;

  console.log(
    `[task-import] tasks ${summary.tasks_inserted}+${summary.tasks_updated}u, ` +
      `complete=${summary.tasks_complete}, incomplete=${summary.tasks_incomplete}, ` +
      `accountability_rows=${summary.accountability_rows}, ` +
      `ownership_rows=${summary.ownership_rows}, ` +
      `unmatched_owners=${summary.ownership_unmatched.size}`
  );

  // ---- Phase 3: recompute performance ----
  let recomputed = 0;
  for (const key of affectedKeys) {
    const [employee_id, yearStr, quarterStr] = key.split("|");
    const year = parseInt(yearStr, 10);
    const quarter = parseInt(quarterStr, 10) as Quarter;
    const result = await recomputePerformanceForQuarter(
      supabase as SupabaseServer,
      employee_id,
      location_id,
      year,
      quarter
    );
    if (result.ok) recomputed += 1;
    else summary.failures.push(`Recompute ${employee_id} ${year}-Q${quarter}: ${result.error}`);
  }
  console.log(`[task-import] recomputed ${recomputed} performance_records`);

  await supabase
    .from("locations")
    .update({ last_data_uploaded_at: new Date().toISOString() })
    .eq("id", location_id);

  revalidatePath(`/dashboard/locations/${location_id}`);
  revalidatePath("/dashboard/employees");

  const params = new URLSearchParams();
  params.set("task_in", String(summary.tasks_inserted));
  params.set("task_up", String(summary.tasks_updated));
  params.set("task_done", String(summary.tasks_complete));
  params.set("task_undone", String(summary.tasks_incomplete));
  params.set("task_acct", String(summary.accountability_rows));
  params.set("task_owners", String(summary.ownership_rows));
  if (summary.ownership_unmatched.size > 0)
    params.set(
      "task_owners_unmatched",
      Array.from(summary.ownership_unmatched).slice(0, 5).join(", ")
    );
  params.set("task_recomputed", String(recomputed));
  if (taskSkippedOtherLocation > 0)
    params.set("task_skipped_other_location", String(taskSkippedOtherLocation));
  if (summary.warnings.length > 0)
    params.set("task_warnings", summary.warnings.slice(0, 3).join(" | "));
  if (summary.failures.length > 0)
    params.set("task_failures", summary.failures.slice(0, 3).join(" | "));

  redirect(`/dashboard/locations/${location_id}?${params.toString()}`);
}
