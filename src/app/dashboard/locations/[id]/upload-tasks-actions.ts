"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  parseTasksCsv,
  type ParsedTask,
  type TaskImportResult,
} from "@/lib/task-import";
import { recomputePerformanceForQuarter } from "@/lib/performance-recompute";
import { quarterOfDate, type Quarter } from "@/lib/quarter";
import { fuzzyMatchEmployee, type EmployeeCandidate } from "@/lib/fuzzy-match-employee";
import { rowMatchesLocation } from "@/lib/location-match";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

const UPSERT_BATCH_SIZE = 500;
const MIN_OVERLAP_MINUTES = 60; // >= 1 hour overlap = accountable
const FETCH_PAGE = 1000; // PostgREST max-rows is 1000 by default

interface IngestStats {
  tasks_inserted: number;
  tasks_updated: number;
  tasks_complete: number;
  tasks_incomplete: number;
  accountability_rows: number;
  ownership_rows: number;
  ownership_unmatched: Set<string>;
  skipped_other_location: number;
  recomputed: number;
  warnings: string[];
  failures: string[];
}

function newStats(warnings: string[] = []): IngestStats {
  return {
    tasks_inserted: 0,
    tasks_updated: 0,
    tasks_complete: 0,
    tasks_incomplete: 0,
    accountability_rows: 0,
    ownership_rows: 0,
    ownership_unmatched: new Set(),
    skipped_other_location: 0,
    recomputed: 0,
    warnings,
    failures: [],
  };
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
  stats: IngestStats
) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await fn(batch);
    if (error) {
      const msg = `${label} batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}: ${error.message}`;
      console.error("[task-import]", msg);
      stats.failures.push(msg);
    }
  }
}

/**
 * End-to-end task ingest for ONE location. Filters parsed.tasks by
 * location, upserts tasks + accountability + ownership, recomputes
 * affected (employee, quarter) pairs. Returns stats. Pure compute, no
 * redirect/revalidate.
 *
 * Critical: every query that fetches rows by location_id alone is
 * paginated, because PostgREST's default max-rows cap of 1000 silently
 * truncates `.range(0, 99999)`. For locations with 1000+ tasks (Houston
 * already has ~7,000 across uploaded quarters), the truncation caused
 * the post-upsert ID lookup to lose tasks → their accountability/
 * ownership rows never got created.
 */
async function ingestTasksForLocation(
  supabase: SupabaseServer,
  parsed: TaskImportResult,
  location: { id: string; name: string; csv_aliases: string[] | null }
): Promise<IngestStats> {
  const stats = newStats();

  // Filter parsed.tasks to those tagged for THIS location (or untagged).
  const beforeFilter = parsed.tasks.length;
  const locationTasks = parsed.tasks.filter((t) =>
    rowMatchesLocation(t.location_label, location.name, location.csv_aliases)
  );
  stats.skipped_other_location = beforeFilter - locationTasks.length;
  if (locationTasks.length === 0) {
    return stats;
  }

  // ---- Phase 1: bulk upsert tasks ----
  // Existing-task fetch is used only for insert/update counts. Paginate so
  // the counts are right even at 1000+-task locations.
  const existingKey = new Map<string, string>();
  {
    let from = 0;
    while (true) {
      const { data: page } = await supabase
        .from("tasks")
        .select("id, task_list_name, task_name, task_date, start_time")
        .eq("location_id", location.id)
        .range(from, from + FETCH_PAGE - 1);
      if (!page || page.length === 0) break;
      for (const t of page) {
        const k = `${(t.task_list_name as string).toLowerCase()}|${(t.task_name as string).toLowerCase()}|${t.task_date}|${(t.start_time as string | null) ?? ""}`;
        existingKey.set(k, t.id as string);
      }
      if (page.length < FETCH_PAGE) break;
      from += FETCH_PAGE;
    }
  }

  const taskPayloads = locationTasks.map((t: ParsedTask) => {
    const key = `${t.task_list_name.toLowerCase()}|${t.task_name.toLowerCase()}|${t.task_date}|${t.start_time ?? ""}`;
    if (existingKey.has(key)) stats.tasks_updated += 1;
    else stats.tasks_inserted += 1;
    if (t.is_complete) stats.tasks_complete += 1;
    else stats.tasks_incomplete += 1;
    return {
      location_id: location.id,
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
    stats
  );

  // Resolve task IDs (including newly inserted). Filter to ONLY the dates
  // we touched so the fetch stays small AND paginate defensively.
  const touchedDates = Array.from(new Set(locationTasks.map((t) => t.task_date)));
  const taskByKey = new Map<
    string,
    { id: string; date: string; start: string | null; due: string | null }
  >();
  if (touchedDates.length > 0) {
    let from = 0;
    while (true) {
      const { data: page } = await supabase
        .from("tasks")
        .select("id, task_list_name, task_name, task_date, start_time, due_time")
        .eq("location_id", location.id)
        .in("task_date", touchedDates)
        .range(from, from + FETCH_PAGE - 1);
      if (!page || page.length === 0) break;
      for (const t of page) {
        const k = `${(t.task_list_name as string).toLowerCase()}|${(t.task_name as string).toLowerCase()}|${t.task_date}|${(t.start_time as string | null) ?? ""}`;
        taskByKey.set(k, {
          id: t.id as string,
          date: t.task_date as string,
          start: t.start_time as string | null,
          due: t.due_time as string | null,
        });
      }
      if (page.length < FETCH_PAGE) break;
      from += FETCH_PAGE;
    }
  }

  // ---- Phase 2: compute accountability ----
  // Pull worked time_entries on the dates we care about. Filter+paginate so
  // this stays well under the row cap even at large locations.
  const workedByDate = new Map<
    string,
    { employee_id: string; in: number | null; out: number | null }[]
  >();
  if (touchedDates.length > 0) {
    let from = 0;
    while (true) {
      const { data: page } = await supabase
        .from("time_entries")
        .select("employee_id, entry_date, in_time, out_time")
        .eq("location_id", location.id)
        .eq("entry_type", "worked")
        .in("entry_date", touchedDates)
        .range(from, from + FETCH_PAGE - 1);
      if (!page || page.length === 0) break;
      for (const e of page) {
        const list = workedByDate.get(e.entry_date as string);
        const item = {
          employee_id: e.employee_id as string,
          in: timeToSec(e.in_time as string | null),
          out: timeToSec(e.out_time as string | null),
        };
        if (list) list.push(item);
        else workedByDate.set(e.entry_date as string, [item]);
      }
      if (page.length < FETCH_PAGE) break;
      from += FETCH_PAGE;
    }
  }

  // Active employees for ownership matching + worked-set filter.
  const { data: activeEmps } = await supabase
    .from("employees")
    .select("id, employee_name, active")
    .eq("location_id", location.id)
    .eq("active", true);
  const activeSet = new Set((activeEmps ?? []).map((e) => e.id as string));
  const candidates: EmployeeCandidate[] = (activeEmps ?? []).map((e) => ({
    id: e.id as string,
    employee_name: e.employee_name as string,
  }));

  // Filter workedByDate to active employees only (matches existing semantics).
  for (const [d, list] of workedByDate) {
    workedByDate.set(d, list.filter((s) => activeSet.has(s.employee_id)));
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
    if (!out) stats.ownership_unmatched.add(typedName);
    return out;
  }

  for (const t of locationTasks) {
    const key = `${t.task_list_name.toLowerCase()}|${t.task_name.toLowerCase()}|${t.task_date}|${t.start_time ?? ""}`;
    const ref = taskByKey.get(key);
    if (!ref) continue;

    const tStart = timeToSec(ref.start);
    const tDue = timeToSec(ref.due);
    if (tStart === null || tDue === null || tDue <= tStart) continue;

    const dayShifts = workedByDate.get(t.task_date) ?? [];
    for (const s of dayShifts) {
      if (s.in === null || s.out === null) continue;
      // Overnight shift: out_time < in_time means the shift wraps past midnight.
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

    // Ownership rows from completers (deduped per task).
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
        const q = quarterOfDate(new Date(t.task_date + "T12:00:00"));
        affectedKeys.add(`${owner.id}|${q.year}|${q.quarter}`);
      }
    }
  }

  // Replace accountability + ownership only for tasks in THIS upload.
  const importedTaskIds = locationTasks
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
      if (delErr) stats.failures.push(`delete accountability: ${delErr.message}`);
    }
  }
  await chunkOp(
    async (batch: typeof accountabilityPayloads) =>
      await supabase.from("task_accountability").insert(batch),
    accountabilityPayloads,
    "task_accountability",
    stats
  );
  stats.accountability_rows = accountabilityPayloads.length;

  if (importedTaskIds.length > 0) {
    for (let i = 0; i < importedTaskIds.length; i += 500) {
      const chunk = importedTaskIds.slice(i, i + 500);
      const { error: delErr } = await supabase
        .from("task_owners")
        .delete()
        .in("task_id", chunk);
      if (delErr) stats.failures.push(`delete task_owners: ${delErr.message}`);
    }
  }
  await chunkOp(
    async (batch: typeof ownershipPayloads) =>
      await supabase.from("task_owners").insert(batch),
    ownershipPayloads,
    "task_owners",
    stats
  );
  stats.ownership_rows = ownershipPayloads.length;

  // Recompute affected (employee, quarter) pairs.
  for (const key of affectedKeys) {
    const [employee_id, yearStr, quarterStr] = key.split("|");
    const year = parseInt(yearStr, 10);
    const quarter = parseInt(quarterStr, 10) as Quarter;
    const result = await recomputePerformanceForQuarter(
      supabase,
      employee_id,
      location.id,
      year,
      quarter
    );
    if (result.ok) stats.recomputed += 1;
    else stats.failures.push(`Recompute ${employee_id} ${year}-Q${quarter} @ ${location.name}: ${result.error}`);
  }

  await supabase
    .from("locations")
    .update({ last_data_uploaded_at: new Date().toISOString() })
    .eq("id", location.id);

  return stats;
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

  const { data: locRow } = await supabase
    .from("locations")
    .select("id, name, csv_aliases")
    .eq("id", location_id)
    .single();
  const location = (locRow as { id: string; name: string; csv_aliases: string[] | null } | null) ?? {
    id: location_id,
    name: "",
    csv_aliases: null,
  };

  const stats = await ingestTasksForLocation(supabase, parsed, location);
  for (const w of parsed.warnings.slice(0, 10)) stats.warnings.push(w);

  console.log(
    `[task-import] ${location.name}: tasks ${stats.tasks_inserted}+${stats.tasks_updated}u, ` +
      `complete=${stats.tasks_complete}, incomplete=${stats.tasks_incomplete}, ` +
      `accountability_rows=${stats.accountability_rows}, ` +
      `ownership_rows=${stats.ownership_rows}, ` +
      `recomputed=${stats.recomputed}, ` +
      `unmatched_owners=${stats.ownership_unmatched.size}, ` +
      `skipped_other=${stats.skipped_other_location}`
  );

  revalidatePath(`/dashboard/locations/${location_id}`);
  revalidatePath("/dashboard/employees");

  const params = new URLSearchParams();
  params.set("task_in", String(stats.tasks_inserted));
  params.set("task_up", String(stats.tasks_updated));
  params.set("task_done", String(stats.tasks_complete));
  params.set("task_undone", String(stats.tasks_incomplete));
  params.set("task_acct", String(stats.accountability_rows));
  params.set("task_owners", String(stats.ownership_rows));
  if (stats.ownership_unmatched.size > 0)
    params.set(
      "task_owners_unmatched",
      Array.from(stats.ownership_unmatched).slice(0, 5).join(", ")
    );
  params.set("task_recomputed", String(stats.recomputed));
  if (stats.skipped_other_location > 0)
    params.set("task_skipped_other_location", String(stats.skipped_other_location));
  if (stats.warnings.length > 0)
    params.set("task_warnings", stats.warnings.slice(0, 3).join(" | "));
  if (stats.failures.length > 0)
    params.set("task_failures", stats.failures.slice(0, 3).join(" | "));

  redirect(`/dashboard/locations/${location_id}?${params.toString()}`);
}

/**
 * Bulk: fan out a tasks CSV across many locations (scope=client | scope=all).
 * Routes each task by its Location column to the matching location, then runs
 * the per-location ingest. Aggregates counts + per-location breakdown.
 */
export async function uploadTasksCsvBulkAction(formData: FormData) {
  console.log("[task-import] uploadTasksCsvBulkAction invoked");

  const scope = String(formData.get("scope") ?? "all") as "client" | "all";
  const client_id = scope === "client" ? String(formData.get("client_id") ?? "") : null;
  const file = formData.get("file") as File | null;

  const redirectBase =
    scope === "client" && client_id
      ? `/dashboard/clients/${client_id}`
      : `/dashboard/uploads`;

  if (!file || file.size === 0) {
    redirect(`${redirectBase}?bulk_task_error=${encodeURIComponent("No file uploaded.")}`);
  }

  const supabase = await createClient();
  const text = await file.text();
  const parsed = parseTasksCsv(text);

  if (parsed.errors.length > 0 && parsed.tasks.length === 0) {
    redirect(
      `${redirectBase}?bulk_task_error=${encodeURIComponent(parsed.errors.join("; "))}`
    );
  }

  let q = supabase.from("locations").select("id, name, csv_aliases").order("name");
  if (scope === "client" && client_id) q = q.eq("client_id", client_id);
  const { data: targetsRaw } = await q;
  const targets = (targetsRaw ?? []) as Array<{
    id: string;
    name: string;
    csv_aliases: string[] | null;
  }>;
  if (targets.length === 0) {
    redirect(
      `${redirectBase}?bulk_task_error=${encodeURIComponent(
        scope === "client" ? "No locations under this client." : "No locations exist yet."
      )}`
    );
  }

  const aggregated: IngestStats = newStats();
  const perLocation: Array<{
    name: string;
    in: number;
    up: number;
    acct: number;
    owners: number;
    recomputed: number;
  }> = [];

  for (const loc of targets) {
    const stats = await ingestTasksForLocation(supabase, parsed, loc);
    aggregated.tasks_inserted += stats.tasks_inserted;
    aggregated.tasks_updated += stats.tasks_updated;
    aggregated.tasks_complete += stats.tasks_complete;
    aggregated.tasks_incomplete += stats.tasks_incomplete;
    aggregated.accountability_rows += stats.accountability_rows;
    aggregated.ownership_rows += stats.ownership_rows;
    aggregated.skipped_other_location += stats.skipped_other_location;
    aggregated.recomputed += stats.recomputed;
    for (const n of stats.ownership_unmatched) aggregated.ownership_unmatched.add(n);
    aggregated.failures.push(...stats.failures);
    perLocation.push({
      name: loc.name,
      in: stats.tasks_inserted,
      up: stats.tasks_updated,
      acct: stats.accountability_rows,
      owners: stats.ownership_rows,
      recomputed: stats.recomputed,
    });
  }

  // True unmatched: rows whose location_label matches no target name AND no alias.
  const targetNames = new Set<string>();
  for (const l of targets) {
    targetNames.add(l.name.toLowerCase());
    if (l.csv_aliases) {
      for (const a of l.csv_aliases) {
        if (a) targetNames.add(a.trim().toLowerCase());
      }
    }
  }
  let trulyUnmatched = 0;
  for (const t of parsed.tasks) {
    const lbl = (t.location_label ?? "").trim().toLowerCase();
    if (lbl && !targetNames.has(lbl)) trulyUnmatched += 1;
  }

  for (const loc of targets) revalidatePath(`/dashboard/locations/${loc.id}`);
  revalidatePath("/dashboard/employees");
  if (scope === "client" && client_id) revalidatePath(`/dashboard/clients/${client_id}`);
  revalidatePath("/dashboard/uploads");

  console.log(
    `[task-import] BULK DONE across ${targets.length} locations: ` +
      `tasks=${aggregated.tasks_inserted}+${aggregated.tasks_updated}u, ` +
      `acct=${aggregated.accountability_rows}, owners=${aggregated.ownership_rows}, ` +
      `recomputed=${aggregated.recomputed}, unmatched=${trulyUnmatched}, ` +
      `failures=${aggregated.failures.length}`
  );

  const params = new URLSearchParams();
  params.set("bulk_task_locations", String(targets.length));
  params.set("bulk_task_in", String(aggregated.tasks_inserted));
  params.set("bulk_task_up", String(aggregated.tasks_updated));
  params.set("bulk_task_done", String(aggregated.tasks_complete));
  params.set("bulk_task_undone", String(aggregated.tasks_incomplete));
  params.set("bulk_task_acct", String(aggregated.accountability_rows));
  params.set("bulk_task_owners", String(aggregated.ownership_rows));
  params.set("bulk_task_recomputed", String(aggregated.recomputed));
  params.set("bulk_task_unmatched", String(trulyUnmatched));
  if (aggregated.ownership_unmatched.size > 0)
    params.set(
      "bulk_task_owners_unmatched",
      Array.from(aggregated.ownership_unmatched).slice(0, 5).join(", ")
    );
  const breakdown = perLocation
    .filter((p) => p.in + p.up + p.acct + p.owners > 0)
    .map(
      (p) =>
        `${p.name}: tasks ${p.in}+${p.up}u · acct ${p.acct} · owners ${p.owners} · recomputed ${p.recomputed}`
    )
    .join(" | ");
  if (breakdown) params.set("bulk_task_breakdown", breakdown);
  if (aggregated.failures.length > 0)
    params.set("bulk_task_failures", aggregated.failures.slice(0, 3).join(" | "));

  redirect(`${redirectBase}?${params.toString()}`);
}
