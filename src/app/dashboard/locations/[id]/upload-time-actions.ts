"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseTimeEntriesCsv, type ParsedTimeEntry } from "@/lib/time-entries-import";
import { recomputePerformanceForQuarter } from "@/lib/performance-recompute";
import { quarterOfDate, type Quarter } from "@/lib/quarter";
import { rowMatchesLocation } from "@/lib/location-match";

interface ImportSummary {
  scheduled_inserted: number;
  scheduled_updated: number;
  worked_inserted: number;
  worked_updated: number;
  unknown_employees: Set<string>;
  inactive_skipped: Set<string>;
  skipped_other_location: number;
  failures: string[];
  warnings: string[];
}

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

const UPSERT_BATCH_SIZE = 500;

function buildEntryPayload(
  rec: ParsedTimeEntry,
  employeeId: string,
  locationId: string,
  entryType: "scheduled" | "worked"
) {
  return {
    employee_id: employeeId,
    location_id: locationId,
    entry_date: rec.entry_date,
    entry_type: entryType,
    in_time: rec.in_time,
    out_time: rec.out_time,
    role: rec.role,
    wage: rec.wage,
    regular_hours: rec.regular_hours,
    ot_hours: rec.ot_hours,
    double_ot_hours: rec.double_ot_hours,
    holiday_hours: rec.holiday_hours,
    regular_pay: rec.regular_pay,
    ot_pay: rec.ot_pay,
    double_ot_pay: rec.double_ot_pay,
    holiday_pay: rec.holiday_pay,
    total_pay: rec.total_pay,
  };
}

async function processFile(
  supabase: SupabaseServer,
  file: File,
  locationId: string,
  targetLocationName: string,
  entryType: "scheduled" | "worked",
  activeEmployees: Map<string, string>,
  inactiveEmployees: Set<string>,
  existingKeys: Set<string>,
  summary: ImportSummary
): Promise<{ touched: Set<string>; affectedQuarters: Set<string> }> {
  const touched = new Set<string>();
  const affectedQuarters = new Set<string>(); // "employee_id|year|quarter"
  console.log(
    `[time-import] Processing ${entryType} file (${file.size} bytes, name="${file.name}")`
  );

  const text = await file.text();
  const parsed = parseTimeEntriesCsv(text);
  console.log(
    `[time-import] ${entryType}: parsed ${parsed.rows_in_file} rows -> ${parsed.unique_shifts} unique (date,employee) shifts`
  );

  for (const w of parsed.warnings) summary.warnings.push(`[${entryType}] ${w}`);
  if (parsed.errors.length > 0 && parsed.records.length === 0) {
    summary.failures.push(`[${entryType}] ${parsed.errors.join("; ")}`);
    return { touched, affectedQuarters };
  }

  // Filter out rows whose Location column doesn't match this location. Lets
  // an all-locations CSV upload to multiple locations sequentially without
  // pre-splitting. Rows with no Location value pass through (single-location
  // exports).
  const beforeFilter = parsed.records.length;
  parsed.records = parsed.records.filter((rec) =>
    rowMatchesLocation(rec.location_label, targetLocationName)
  );
  const skippedThisFile = beforeFilter - parsed.records.length;
  summary.skipped_other_location += skippedThisFile;
  if (skippedThisFile > 0) {
    console.log(
      `[time-import] ${entryType}: filtered out ${skippedThisFile} rows tagged for other locations`
    );
  }

  const payloads: ReturnType<typeof buildEntryPayload>[] = [];
  let inserts = 0;
  let updates = 0;

  for (const rec of parsed.records) {
    const empId = activeEmployees.get(rec.employee_name_key);
    if (!empId) {
      if (inactiveEmployees.has(rec.employee_name_key)) {
        summary.inactive_skipped.add(rec.employee_name_display);
      } else {
        summary.unknown_employees.add(rec.employee_name_display);
      }
      continue;
    }

    const key = `${empId}|${rec.entry_date}|${entryType}`;
    if (existingKeys.has(key)) updates += 1;
    else inserts += 1;
    existingKeys.add(key);

    payloads.push(buildEntryPayload(rec, empId, locationId, entryType));
    touched.add(empId);

    // Track which (employee, quarter) is affected so we can recompute later.
    const q = quarterOfDate(new Date(rec.entry_date));
    affectedQuarters.add(`${empId}|${q.year}|${q.quarter}`);
  }

  for (let i = 0; i < payloads.length; i += UPSERT_BATCH_SIZE) {
    const batch = payloads.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await supabase
      .from("time_entries")
      .upsert(batch, { onConflict: "employee_id,entry_date,entry_type" });
    if (error) {
      summary.failures.push(
        `[${entryType}] batch ${i / UPSERT_BATCH_SIZE + 1}: ${error.message}`
      );
      console.error(`[time-import] ${entryType} batch error:`, error);
    }
  }

  if (entryType === "scheduled") {
    summary.scheduled_inserted += inserts;
    summary.scheduled_updated += updates;
  } else {
    summary.worked_inserted += inserts;
    summary.worked_updated += updates;
  }

  console.log(
    `[time-import] ${entryType} done: ${inserts} new, ${updates} updated; ${affectedQuarters.size} (employee, quarter) pairs affected`
  );
  return { touched, affectedQuarters };
}

export async function uploadTimeDataAction(formData: FormData) {
  console.log("[time-import] uploadTimeDataAction invoked");

  const location_id = String(formData.get("location_id") ?? "");
  const scheduledFile = formData.get("scheduled_file") as File | null;
  const workedFile = formData.get("worked_file") as File | null;

  console.log(
    `[time-import] location_id=${location_id} scheduled=${
      scheduledFile?.size ?? 0
    } worked=${workedFile?.size ?? 0}`
  );

  if (!location_id) {
    redirect(
      `/dashboard/locations?time_error=${encodeURIComponent("Missing location.")}`
    );
  }
  if (
    (!scheduledFile || scheduledFile.size === 0) &&
    (!workedFile || workedFile.size === 0)
  ) {
    redirect(
      `/dashboard/locations/${location_id}?time_error=${encodeURIComponent(
        "Upload at least one file (Scheduled or Worked)."
      )}`
    );
  }

  const supabase = await createClient();

  // Fetch active/inactive employees for this location (single query)
  const { data: locationEmployees, error: empErr } = await supabase
    .from("employees")
    .select("id, employee_name, active")
    .eq("location_id", location_id);
  if (empErr) {
    console.error("[time-import] failed to fetch location employees:", empErr);
    redirect(
      `/dashboard/locations/${location_id}?time_error=${encodeURIComponent(
        "Could not fetch employees: " + empErr.message
      )}`
    );
  }

  const activeEmployees = new Map<string, string>();
  const inactiveEmployees = new Set<string>();
  for (const e of locationEmployees ?? []) {
    const key = e.employee_name.toLowerCase();
    if (e.active) activeEmployees.set(key, e.id);
    else inactiveEmployees.add(key);
  }
  console.log(
    `[time-import] active employees at this location: ${activeEmployees.size}; inactive: ${inactiveEmployees.size}`
  );

  // Pre-fetch existing time entry keys for this location (single query) so we can
  // distinguish inserts from updates without per-row lookups.
  const { data: existingRows } = await supabase
    .from("time_entries")
    .select("employee_id, entry_date, entry_type")
    .eq("location_id", location_id);
  const existingKeys = new Set<string>();
  for (const r of existingRows ?? []) {
    existingKeys.add(`${r.employee_id}|${r.entry_date}|${r.entry_type}`);
  }
  console.log(`[time-import] existing time_entries at this location: ${existingKeys.size}`);

  // Look up the target location's display name so we can filter all-locations
  // CSV exports down to rows for THIS location.
  const { data: locRow } = await supabase
    .from("locations")
    .select("name")
    .eq("id", location_id)
    .single();
  const targetLocationName = (locRow?.name as string | undefined) ?? "";

  const summary: ImportSummary = {
    scheduled_inserted: 0,
    scheduled_updated: 0,
    worked_inserted: 0,
    worked_updated: 0,
    unknown_employees: new Set(),
    inactive_skipped: new Set(),
    skipped_other_location: 0,
    failures: [],
    warnings: [],
  };

  const affectedKeys = new Set<string>();
  if (scheduledFile && scheduledFile.size > 0) {
    const { affectedQuarters } = await processFile(
      supabase,
      scheduledFile,
      location_id,
      targetLocationName,
      "scheduled",
      activeEmployees,
      inactiveEmployees,
      existingKeys,
      summary
    );
    for (const k of affectedQuarters) affectedKeys.add(k);
  }
  if (workedFile && workedFile.size > 0) {
    const { affectedQuarters } = await processFile(
      supabase,
      workedFile,
      location_id,
      targetLocationName,
      "worked",
      activeEmployees,
      inactiveEmployees,
      existingKeys,
      summary
    );
    for (const k of affectedQuarters) affectedKeys.add(k);
  }
  console.log(
    `[time-import] recomputing performance for ${affectedKeys.size} (employee, quarter) pairs`
  );

  let recomputed = 0;
  for (const key of affectedKeys) {
    const [employee_id, yearStr, quarterStr] = key.split("|");
    const year = parseInt(yearStr, 10);
    const quarter = parseInt(quarterStr, 10) as Quarter;
    const result = await recomputePerformanceForQuarter(
      supabase,
      employee_id,
      location_id,
      year,
      quarter
    );
    if (result.ok) recomputed += 1;
    else
      summary.failures.push(
        `Recompute ${employee_id} ${year}-Q${quarter}: ${result.error}`
      );
  }

  await supabase
    .from("locations")
    .update({ last_data_uploaded_at: new Date().toISOString() })
    .eq("id", location_id);

  revalidatePath(`/dashboard/locations/${location_id}`);
  revalidatePath("/dashboard/employees");

  console.log(
    `[time-import] DONE. sched=${summary.scheduled_inserted}+${summary.scheduled_updated}u, ` +
      `worked=${summary.worked_inserted}+${summary.worked_updated}u, ` +
      `recomputed=${recomputed}, ` +
      `unknown=${summary.unknown_employees.size}, inactive=${summary.inactive_skipped.size}, ` +
      `failures=${summary.failures.length}`
  );

  const params = new URLSearchParams();
  params.set("sched_in", String(summary.scheduled_inserted));
  params.set("sched_up", String(summary.scheduled_updated));
  params.set("work_in", String(summary.worked_inserted));
  params.set("work_up", String(summary.worked_updated));
  params.set("recomputed", String(recomputed));
  if (summary.unknown_employees.size > 0)
    params.set(
      "unknown",
      Array.from(summary.unknown_employees).slice(0, 5).join(", ")
    );
  if (summary.inactive_skipped.size > 0)
    params.set(
      "inactive",
      Array.from(summary.inactive_skipped).slice(0, 5).join(", ")
    );
  if (summary.skipped_other_location > 0)
    params.set("time_skipped_other_location", String(summary.skipped_other_location));
  if (summary.warnings.length > 0)
    params.set("warnings", summary.warnings.slice(0, 3).join(" | "));
  if (summary.failures.length > 0)
    params.set("failures", summary.failures.slice(0, 3).join(" | "));

  redirect(`/dashboard/locations/${location_id}?${params.toString()}`);
}
