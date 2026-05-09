"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseSurveyCsv } from "@/lib/survey-import";
import { recomputePerformanceForQuarter } from "@/lib/performance-recompute";
import { quarterOfDate, type Quarter } from "@/lib/quarter";
import {
  fuzzyMatchEmployee,
  type EmployeeCandidate,
  type MatchConfidence,
} from "@/lib/fuzzy-match-employee";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

const UPSERT_BATCH_SIZE = 250;
const SURVEY_WINDOW_DAYS = 7; // [sent_date, sent_date + 6] inclusive

interface ImportSummary {
  surveys_inserted: number;
  surveys_updated: number;
  assignments_inserted: number;
  assignments_updated: number;
  completions_matched: number;
  completions_ambiguous: Set<string>;
  completions_unmatched: Set<string>;
  match_confidence_counts: Record<MatchConfidence, number>;
  /**
   * Number of (employee, survey-week) pairs we dropped because the employee
   * is currently INACTIVE in our DB. They had a time entry during the survey
   * week but are no longer active, so they shouldn't be in the engagement
   * denominator for any Q3/Q4 2025 weeks (and equally for any future
   * deactivations). Tracked for diagnostics; surfaced in the result banner.
   */
  inactive_pool_skipped: number;
  warnings: string[];
  failures: string[];
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
      console.error("[survey-import]", msg);
      summary.failures.push(msg);
    }
  }
}

export async function uploadSurveyCsvAction(formData: FormData) {
  console.log("[survey-import] uploadSurveyCsvAction invoked");

  const location_id = String(formData.get("location_id") ?? "");
  const file = formData.get("file") as File | null;

  if (!location_id) {
    redirect(
      `/dashboard/locations?survey_error=${encodeURIComponent("Missing location.")}`
    );
  }
  if (!file || file.size === 0) {
    redirect(
      `/dashboard/locations/${location_id}?survey_error=${encodeURIComponent("No file uploaded.")}`
    );
  }

  const supabase = await createClient();
  const text = await file.text();
  const parsed = parseSurveyCsv(text);
  console.log(
    `[survey-import] parsed ${parsed.rows_in_file} rows -> ${parsed.unique_assignments} completion records across ${parsed.unique_surveys} surveys`
  );

  if (parsed.errors.length > 0 && parsed.assignments.length === 0) {
    redirect(
      `/dashboard/locations/${location_id}?survey_error=${encodeURIComponent(
        parsed.errors.join("; ")
      )}`
    );
  }

  const summary: ImportSummary = {
    surveys_inserted: 0,
    surveys_updated: 0,
    assignments_inserted: 0,
    assignments_updated: 0,
    completions_matched: 0,
    completions_ambiguous: new Set(),
    completions_unmatched: new Set(),
    match_confidence_counts: {
      exact: 0,
      first_name: 0,
      token_containment: 0,
      levenshtein: 0,
      ambiguous: 0,
      none: 0,
    },
    inactive_pool_skipped: 0,
    warnings: parsed.warnings.slice(0, 10),
    failures: [],
  };

  // ---- All employees at this location (active only) — used for fuzzy matching ----
  const { data: locEmployees } = await supabase
    .from("employees")
    .select("id, employee_name, active")
    .eq("location_id", location_id)
    .eq("active", true);

  const candidates: EmployeeCandidate[] = (locEmployees ?? []).map((e) => ({
    id: e.id,
    employee_name: e.employee_name,
  }));
  // Same set, indexed for O(1) "is this employee active?" checks while we
  // build the assignment pool from time entries.
  const activeIds = new Set<string>(candidates.map((c) => c.id));
  console.log(`[survey-import] candidate pool: ${candidates.length} active employees`);

  // ---- Phase 1: upsert surveys catalog ----
  type SurveyKey = string; // `${titleLower}|${sentDate ?? ""}`
  const surveyMap = new Map<
    SurveyKey,
    { title: string; sent_date: string | null; external_survey_id: string | null }
  >();
  for (const a of parsed.assignments) {
    const key = `${a.survey_title.toLowerCase()}|${a.sent_date ?? ""}`;
    const existing = surveyMap.get(key);
    if (!existing) {
      surveyMap.set(key, {
        title: a.survey_title,
        sent_date: a.sent_date,
        external_survey_id: a.external_survey_id,
      });
    } else if (!existing.external_survey_id && a.external_survey_id) {
      existing.external_survey_id = a.external_survey_id;
    }
  }

  const { data: existingSurveys } = await supabase
    .from("surveys")
    .select("id, title, sent_date")
    .eq("location_id", location_id)
    .range(0, 9999);
  const existingSurveyKey = new Map<string, string>();
  for (const s of existingSurveys ?? []) {
    const k = `${(s.title as string).toLowerCase()}|${(s.sent_date as string | null) ?? ""}`;
    existingSurveyKey.set(k, s.id);
  }
  for (const k of surveyMap.keys()) {
    if (existingSurveyKey.has(k)) summary.surveys_updated += 1;
    else summary.surveys_inserted += 1;
  }

  const surveyPayloads = Array.from(surveyMap.values()).map((s) => ({
    location_id,
    title: s.title,
    sent_date: s.sent_date,
    external_survey_id: s.external_survey_id,
  }));
  await chunkOp(
    async (batch: typeof surveyPayloads) =>
      await supabase
        .from("surveys")
        .upsert(batch, { onConflict: "location_id,title,sent_date" }),
    surveyPayloads,
    "surveys",
    summary
  );

  const { data: nowSurveys } = await supabase
    .from("surveys")
    .select("id, title, sent_date")
    .eq("location_id", location_id)
    .range(0, 9999);
  const surveyIdByKey = new Map<string, string>();
  for (const s of nowSurveys ?? []) {
    const k = `${(s.title as string).toLowerCase()}|${(s.sent_date as string | null) ?? ""}`;
    surveyIdByKey.set(k, s.id);
  }

  // ---- Phase 2: fuzzy match typed names per survey ----
  // completionsBySurvey[surveyKey] = Map<employeeId, { completion_date, response_data }>
  const completionsBySurvey = new Map<
    string,
    Map<string, { completion_date: string | null; response_data: unknown }>
  >();

  for (const a of parsed.assignments) {
    if (!a.completed) continue; // only handle completion rows here
    const surveyKey = `${a.survey_title.toLowerCase()}|${a.sent_date ?? ""}`;

    const result = fuzzyMatchEmployee(a.employee_name_display, candidates);
    summary.match_confidence_counts[result.confidence] += 1;

    if (!result.match) {
      if (result.confidence === "ambiguous") {
        summary.completions_ambiguous.add(
          `${a.employee_name_display} (could be: ${result.candidates_considered?.map((c) => c.employee_name).join(", ")})`
        );
      } else {
        summary.completions_unmatched.add(a.employee_name_display);
      }
      continue;
    }

    summary.completions_matched += 1;
    let map = completionsBySurvey.get(surveyKey);
    if (!map) {
      map = new Map();
      completionsBySurvey.set(surveyKey, map);
    }
    // If the employee already had a completion in this survey, keep the earliest completion_date.
    const prev = map.get(result.match.id);
    if (!prev) {
      map.set(result.match.id, {
        completion_date: a.completion_date,
        response_data: a.response_data ?? null,
      });
    } else if (
      a.completion_date &&
      (!prev.completion_date || a.completion_date < prev.completion_date)
    ) {
      prev.completion_date = a.completion_date;
    }
  }

  // ---- Phase 3: derive assignment pool from time_entries per survey, and write assignments ----
  // For each survey with a sent_date, the pool = employees who worked at this location
  // during [sent_date, sent_date + 6 days]. Plus any matched completions whose employee
  // didn't work that week (data gaps; still attribute them).
  const assignmentPayloads: Array<{
    survey_id: string;
    employee_id: string;
    completed: boolean;
    completion_date: string | null;
    response_data: unknown;
  }> = [];
  const affectedKeys = new Set<string>();

  for (const [surveyKey, surveyMeta] of surveyMap) {
    const surveyId = surveyIdByKey.get(surveyKey);
    if (!surveyId) continue;

    const sentDate = surveyMeta.sent_date;
    if (!sentDate) {
      // Without a sent_date we can't derive a pool. Fall back to: only the matched completions.
      const completions = completionsBySurvey.get(surveyKey);
      if (!completions) continue;
      for (const [empId, comp] of completions) {
        assignmentPayloads.push({
          survey_id: surveyId,
          employee_id: empId,
          completed: true,
          completion_date: comp.completion_date,
          response_data: comp.response_data,
        });
      }
      summary.warnings.push(
        `Survey "${surveyMeta.title}" has no sent_date — assignment pool not derived; only matched completions stored.`
      );
      continue;
    }

    // Compute end of survey window
    const start = new Date(sentDate + "T00:00:00");
    const end = new Date(start);
    end.setDate(end.getDate() + (SURVEY_WINDOW_DAYS - 1));
    const endIso = end.toISOString().slice(0, 10);

    const { data: workedEntries } = await supabase
      .from("time_entries")
      .select("employee_id")
      .eq("location_id", location_id)
      .eq("entry_type", "worked")
      .gte("entry_date", sentDate)
      .lte("entry_date", endIso)
      .range(0, 9999);

    const completions = completionsBySurvey.get(surveyKey) ?? new Map();
    const pool = new Set<string>();
    // Only build the denominator from CURRENTLY ACTIVE employees. An
    // employee who worked this week but has since been deactivated should
    // not count against engagement % for any survey window — Tucker called
    // this out for the Q3/Q4 2025 backfill but the rule applies generally.
    for (const e of workedEntries ?? []) {
      const empId = e.employee_id as string;
      if (activeIds.has(empId)) pool.add(empId);
      else summary.inactive_pool_skipped += 1;
    }
    // Matched completions are already active-only by construction (the
    // candidate pool is filtered to active=true), so this union is safe.
    for (const empId of completions.keys()) pool.add(empId);

    for (const empId of pool) {
      const completion = completions.get(empId);
      assignmentPayloads.push({
        survey_id: surveyId,
        employee_id: empId,
        completed: !!completion,
        completion_date: completion?.completion_date ?? null,
        response_data: completion?.response_data ?? null,
      });
      const q = quarterOfDate(start);
      affectedKeys.add(`${empId}|${q.year}|${q.quarter}`);
    }
  }

  // Pre-fetch existing assignments for accurate insert/update counts
  const touchedSurveyIds = Array.from(new Set(Array.from(surveyIdByKey.values())));
  let existingKeys = new Set<string>();
  if (touchedSurveyIds.length > 0) {
    const { data: existingAssns } = await supabase
      .from("survey_assignments")
      .select("survey_id, employee_id")
      .in("survey_id", touchedSurveyIds)
      .range(0, 99999);
    existingKeys = new Set(
      (existingAssns ?? []).map((r) => `${r.survey_id}|${r.employee_id}`)
    );
  }
  for (const a of assignmentPayloads) {
    const key = `${a.survey_id}|${a.employee_id}`;
    if (existingKeys.has(key)) summary.assignments_updated += 1;
    else summary.assignments_inserted += 1;
    existingKeys.add(key);
  }

  await chunkOp(
    async (batch: typeof assignmentPayloads) =>
      await supabase
        .from("survey_assignments")
        .upsert(batch, { onConflict: "survey_id,employee_id" }),
    assignmentPayloads,
    "survey_assignments",
    summary
  );

  console.log(
    `[survey-import] surveys ${summary.surveys_inserted}+${summary.surveys_updated}u, ` +
      `assignments ${summary.assignments_inserted}+${summary.assignments_updated}u; ` +
      `matches: exact=${summary.match_confidence_counts.exact}, ` +
      `first_name=${summary.match_confidence_counts.first_name}, ` +
      `tokens=${summary.match_confidence_counts.token_containment}, ` +
      `levenshtein=${summary.match_confidence_counts.levenshtein}, ` +
      `ambiguous=${summary.match_confidence_counts.ambiguous}, ` +
      `unmatched=${summary.match_confidence_counts.none}`
  );

  // ---- Phase 4: recompute performance for affected (employee, quarter) ----
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
  console.log(`[survey-import] recomputed ${recomputed} performance_records`);

  await supabase
    .from("locations")
    .update({ last_data_uploaded_at: new Date().toISOString() })
    .eq("id", location_id);

  revalidatePath(`/dashboard/locations/${location_id}`);
  revalidatePath("/dashboard/employees");

  const params = new URLSearchParams();
  params.set("survey_in", String(summary.surveys_inserted));
  params.set("survey_up", String(summary.surveys_updated));
  params.set("assn_in", String(summary.assignments_inserted));
  params.set("assn_up", String(summary.assignments_updated));
  params.set("matches", String(summary.completions_matched));
  params.set(
    "match_breakdown",
    `exact=${summary.match_confidence_counts.exact} first=${summary.match_confidence_counts.first_name} tokens=${summary.match_confidence_counts.token_containment} fuzzy=${summary.match_confidence_counts.levenshtein}`
  );
  params.set("survey_recomputed", String(recomputed));
  if (summary.inactive_pool_skipped > 0)
    params.set(
      "survey_inactive_skipped",
      String(summary.inactive_pool_skipped)
    );
  if (summary.completions_unmatched.size > 0)
    params.set(
      "survey_unmatched",
      Array.from(summary.completions_unmatched).slice(0, 8).join(", ")
    );
  if (summary.completions_ambiguous.size > 0)
    params.set(
      "survey_ambiguous",
      Array.from(summary.completions_ambiguous).slice(0, 5).join(" | ")
    );
  if (summary.warnings.length > 0)
    params.set("survey_warnings", summary.warnings.slice(0, 3).join(" | "));
  if (summary.failures.length > 0)
    params.set("survey_failures", summary.failures.slice(0, 3).join(" | "));

  redirect(`/dashboard/locations/${location_id}?${params.toString()}`);
}
