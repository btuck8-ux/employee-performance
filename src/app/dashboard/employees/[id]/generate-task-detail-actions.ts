"use server";
import { revalidatePath } from "next/cache";
import { renderToBuffer } from "@react-pdf/renderer";
import React from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  EmployeeTaskDetailReportDocument,
  TASK_DETAIL_TEMPLATE_VERSION,
  type TaskDetailReportData,
} from "@/lib/pdf/EmployeeTaskDetailReport";

/** Build the Task Detail report dataset for one (employee, report_period). */
export async function buildTaskDetailData(
  supabase: SupabaseClient,
  performance_record_id: string
): Promise<TaskDetailReportData | null> {
  const { data: pr } = await supabase
    .from("performance_records")
    .select(
      `id, employee_id, location_id, report_period_id,
       tasks_accountable, tasks_completed, tasks_owned,
       task_completion_pct, task_list_completion_pct, avg_task_list_completion_pct,
       employees(employee_name, employee_code, hire_date),
       locations(name),
       report_periods(label, period_start, period_end)`
    )
    .eq("id", performance_record_id)
    .single();
  if (!pr) return null;

  const emp = pr.employees as unknown as {
    employee_name: string;
    employee_code: string;
    hire_date: string | null;
  } | null;
  const loc = pr.locations as unknown as { name: string } | null;
  const period = pr.report_periods as unknown as {
    label: string;
    period_start: string;
    period_end: string;
  } | null;
  if (!emp || !loc || !period) return null;

  // Pull employee's accountable tasks within the quarter
  type AcctRow = {
    overlap_minutes: number;
    tasks: {
      id: string;
      task_list_name: string;
      task_name: string;
      task_date: string;
      is_complete: boolean;
    } | null;
  };
  const { data: acctRows } = await supabase
    .from("task_accountability")
    .select(
      "overlap_minutes, tasks!inner(id, task_list_name, task_name, task_date, is_complete)"
    )
    .eq("employee_id", pr.employee_id)
    .gte("tasks.task_date", period.period_start)
    .lte("tasks.task_date", period.period_end);

  type AcctTask = NonNullable<AcctRow["tasks"]>;
  const accountable: AcctTask[] = ((acctRows ?? []) as unknown as AcctRow[])
    .map((r) => r.tasks)
    .filter((t): t is AcctTask => Boolean(t));

  // Pull owned tasks for this employee in the period (independent of accountability)
  const { data: ownedRowsRaw } = await supabase
    .from("task_owners")
    .select("task_id, tasks!inner(id, task_list_name, task_name, task_date)")
    .eq("employee_id", pr.employee_id)
    .gte("tasks.task_date", period.period_start)
    .lte("tasks.task_date", period.period_end);
  type OwnedRow = {
    task_id: string;
    tasks: { id: string; task_list_name: string; task_name: string; task_date: string } | null;
  };
  const ownedTaskIdSet = new Set<string>();
  for (const r of (ownedRowsRaw ?? []) as unknown as OwnedRow[]) {
    if (r.task_id) ownedTaskIdSet.add(r.task_id);
  }
  const tasks_owned_count = ownedTaskIdSet.size;

  // ---- per-task aggregate ----
  const perTaskMap = new Map<
    string,
    { list: string; task: string; acc: number; done: number; owned: number }
  >();
  for (const t of accountable) {
    const key = `${t.task_list_name}||${t.task_name}`;
    const wasOwned = ownedTaskIdSet.has(t.id) ? 1 : 0;
    const ex = perTaskMap.get(key);
    if (!ex) {
      perTaskMap.set(key, {
        list: t.task_list_name,
        task: t.task_name,
        acc: 1,
        done: t.is_complete ? 1 : 0,
        owned: wasOwned,
      });
    } else {
      ex.acc += 1;
      if (t.is_complete) ex.done += 1;
      ex.owned += wasOwned;
    }
  }
  const perTaskRows = Array.from(perTaskMap.values()).map((r) => ({
    list_name: r.list,
    task_name: r.task,
    accountable: r.acc,
    completed: r.done,
    owned: r.owned,
    completion_pct: r.acc > 0 ? (r.done / r.acc) * 100 : null,
  }));
  perTaskRows.sort((a, b) => (a.completion_pct ?? 0) - (b.completion_pct ?? 0));

  // ---- daily aggregate ----
  const perDayMap = new Map<string, { acc: number; done: number }>();
  for (const t of accountable) {
    const ex = perDayMap.get(t.task_date);
    if (!ex) perDayMap.set(t.task_date, { acc: 1, done: t.is_complete ? 1 : 0 });
    else {
      ex.acc += 1;
      if (t.is_complete) ex.done += 1;
    }
  }
  const dailyRows = Array.from(perDayMap.entries())
    .sort()
    .map(([date, v]) => ({
      date,
      accountable: v.acc,
      completed: v.done,
      completion_pct: v.acc > 0 ? (v.done / v.acc) * 100 : null,
    }));

  // ---- weekly aggregate (Mon-Sun) ----
  function weekStart(dateStr: string): string {
    const d = new Date(dateStr + "T12:00:00");
    const day = d.getDay(); // 0=Sun..6=Sat
    const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
  }
  const perWeekMap = new Map<string, { acc: number; done: number }>();
  for (const t of accountable) {
    const wk = weekStart(t.task_date);
    const ex = perWeekMap.get(wk);
    if (!ex) perWeekMap.set(wk, { acc: 1, done: t.is_complete ? 1 : 0 });
    else {
      ex.acc += 1;
      if (t.is_complete) ex.done += 1;
    }
  }
  const weeklyRows = Array.from(perWeekMap.entries())
    .sort()
    .map(([week_start, v]) => ({
      week_start,
      accountable: v.acc,
      completed: v.done,
      completion_pct: v.acc > 0 ? (v.done / v.acc) * 100 : null,
    }));

  // ---- per-list aggregate ----
  // For each (list_name, task_date) the employee was accountable for, compute the
  // list-instance's completion rate using ALL tasks in that (list, date), not just
  // the accountable ones.
  const accountableListInstances = new Map<string, { list: string; date: string }>();
  for (const t of accountable) {
    const k = `${t.task_list_name}||${t.task_date}`;
    if (!accountableListInstances.has(k)) {
      accountableListInstances.set(k, { list: t.task_list_name, date: t.task_date });
    }
  }

  const perListMap = new Map<
    string,
    { instances: number; full: number; rates: number[] }
  >();
  let total_instances_accountable = 0;
  let total_instances_full = 0;

  // Batched per-list completion math — same optimization as performance-recompute.
  // Pull every task at this location whose date is in the accountable date set
  // in ONE query, then aggregate in JS. Replaces N sequential queries (one per
  // accountable list-instance) with a single round-trip.
  const accountableDateSet = new Set<string>();
  const accountableKeySet = new Set<string>(); // `${listLower}|${date}`
  // Preserve the original casing of each list name for the per-list table
  // display, keyed by lower-cased key.
  const canonicalNameByKey = new Map<string, string>();
  for (const inst of accountableListInstances.values()) {
    accountableDateSet.add(inst.date);
    const k = `${inst.list.toLowerCase()}|${inst.date}`;
    accountableKeySet.add(k);
    if (!canonicalNameByKey.has(k)) canonicalNameByKey.set(k, inst.list);
  }

  if (accountableDateSet.size > 0) {
    const { data: allListTasks } = await supabase
      .from("tasks")
      .select("is_complete, task_list_name, task_date")
      .eq("location_id", pr.location_id)
      .in("task_date", Array.from(accountableDateSet))
      .range(0, 99999);

    // Group raw rows by (listLower, date), filtering to accountable instances.
    type GroupCount = { total: number; done: number };
    const groupCounts = new Map<string, GroupCount>();
    for (const t of allListTasks ?? []) {
      const listLower = (t.task_list_name as string).toLowerCase();
      const key = `${listLower}|${t.task_date as string}`;
      if (!accountableKeySet.has(key)) continue;
      const ex = groupCounts.get(key);
      if (!ex) {
        groupCounts.set(key, { total: 1, done: t.is_complete ? 1 : 0 });
      } else {
        ex.total += 1;
        if (t.is_complete) ex.done += 1;
      }
    }

    for (const [key, { total, done }] of groupCounts) {
      if (total === 0) continue;
      const rate = (done / total) * 100;
      const isFull = done === total;

      total_instances_accountable += 1;
      if (isFull) total_instances_full += 1;

      const displayName = canonicalNameByKey.get(key) ?? key.split("|")[0];
      const ex = perListMap.get(displayName);
      if (!ex) {
        perListMap.set(displayName, { instances: 1, full: isFull ? 1 : 0, rates: [rate] });
      } else {
        ex.instances += 1;
        if (isFull) ex.full += 1;
        ex.rates.push(rate);
      }
    }
  }

  const perListRows = Array.from(perListMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([list_name, v]) => ({
      list_name,
      instances_accountable: v.instances,
      instances_full: v.full,
      full_rate_pct: v.instances > 0 ? (v.full / v.instances) * 100 : null,
      avg_completion_pct:
        v.rates.length > 0 ? v.rates.reduce((a, b) => a + b, 0) / v.rates.length : null,
    }));

  const data: TaskDetailReportData = {
    employee_name: emp.employee_name,
    employee_code: emp.employee_code,
    location_name: loc.name,
    hire_date: emp.hire_date,
    report_period_label: period.label,
    report_period_start: period.period_start,
    report_period_end: period.period_end,
    generated_at: new Date().toISOString(),
    summary: {
      tasks_accountable: pr.tasks_accountable as number ?? accountable.length,
      tasks_completed:
        (pr.tasks_completed as number) ?? accountable.filter((t) => t.is_complete).length,
      tasks_owned: (pr.tasks_owned as number | null) ?? tasks_owned_count,
      task_completion_pct:
        pr.task_completion_pct === null
          ? null
          : Number(pr.task_completion_pct as number),
      task_list_completion_pct:
        pr.task_list_completion_pct === null
          ? null
          : Number(pr.task_list_completion_pct as number),
      avg_task_list_completion_pct:
        pr.avg_task_list_completion_pct === null
          ? null
          : Number(pr.avg_task_list_completion_pct as number),
      list_instances_accountable: total_instances_accountable,
      list_instances_full: total_instances_full,
    },
    per_task: perTaskRows,
    daily: dailyRows,
    weekly: weeklyRows,
    per_list: perListRows,
  };

  // Empty-period guard: if this quarter has zero accountable tasks AND zero
  // ownership rows, there's nothing meaningful to render. Returning null
  // tells callers to silently skip — the bundled "+Task detail" path falls
  // back to performance-only, and the standalone action no-ops cleanly.
  // This is what saves us from generating empty-data PDFs for periods that
  // pre-date a location's tasks program (e.g., Q3/Q4 2025 at TSN).
  if (
    (data.summary.tasks_accountable ?? 0) === 0 &&
    (data.summary.tasks_owned ?? 0) === 0
  ) {
    return null;
  }

  return data;
}

/**
 * Render + persist a Task Detail PDF for a (employee, performance_record).
 * Used both by the standalone action below and by the performance-report
 * generation when the "Include task detail" checkbox is checked.
 */
export async function renderAndStoreTaskDetail(
  supabase: SupabaseClient,
  performance_record_id: string,
  generated_by: string | null
): Promise<{ ok: boolean; error?: string; report_id?: string }> {
  const data = await buildTaskDetailData(supabase, performance_record_id);
  if (!data) return { ok: false, error: "Could not build task detail data." };

  const docElement = React.createElement(EmployeeTaskDetailReportDocument, { data });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buffer = await renderToBuffer(docElement as any);

  const { data: pr } = await supabase
    .from("performance_records")
    .select("id, employee_id, location_id, report_period_id")
    .eq("id", performance_record_id)
    .single();
  if (!pr) return { ok: false, error: "performance_record not found" };

  const safeName = data.employee_name.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const safePeriod = data.report_period_label.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const storage_path = `${pr.location_id}/${pr.employee_id}/task_detail_${safePeriod}_${safeName}_${Date.now()}.pdf`;

  const { error: uploadError } = await supabase.storage
    .from("reports")
    .upload(storage_path, buffer, { contentType: "application/pdf", upsert: false });
  if (uploadError) return { ok: false, error: uploadError.message };

  const generated_at = data.generated_at;

  // Supersede prior task_detail report for this (employee, period)
  await supabase
    .from("generated_reports")
    .update({ superseded_at: generated_at })
    .eq("employee_id", pr.employee_id)
    .eq("report_period_id", pr.report_period_id)
    .eq("report_kind", "task_detail")
    .is("superseded_at", null);

  const { data: inserted, error: insertError } = await supabase
    .from("generated_reports")
    .insert({
      performance_record_id: pr.id,
      employee_id: pr.employee_id,
      location_id: pr.location_id,
      report_period_id: pr.report_period_id,
      generation_mode: "quarterly",
      report_kind: "task_detail",
      storage_path,
      template_version: TASK_DETAIL_TEMPLATE_VERSION,
      generated_at,
      generated_by,
    })
    .select("id")
    .single();
  if (insertError) return { ok: false, error: insertError.message };
  return { ok: true, report_id: inserted?.id as string };
}

export async function generateTaskDetailReportAction(formData: FormData) {
  const performance_record_id = String(formData.get("performance_record_id") ?? "");
  const employee_id = String(formData.get("employee_id") ?? "");
  if (!performance_record_id || !employee_id) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const result = await renderAndStoreTaskDetail(
    supabase,
    performance_record_id,
    user?.id ?? null
  );
  if (!result.ok) {
    console.error("[task-detail] generation failed:", result.error);
  } else {
    console.log("[task-detail] generated:", result.report_id);
  }
  revalidatePath(`/dashboard/employees/${employee_id}`);
}
