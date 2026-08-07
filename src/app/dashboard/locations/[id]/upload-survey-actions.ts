"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { parseSurveyCsv, type SurveyImportResult } from "@/lib/survey-import";
import { recomputePerformanceForQuarter } from "@/lib/performance-recompute";
import { quarterOfDate, type Quarter } from "@/lib/quarter";
import {
  fuzzyMatchEmployee,
  type EmployeeCandidate,
  type MatchConfidence,
} from "@/lib/fuzzy-match-employee";
import { rowMatchesLocation } from "@/lib/location-match";
import { runSingleUpload, runBulkUpload } from "@/lib/upload-action-kit";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

const UPSERT_BATCH_SIZE = 250;
const FETCH_PAGE = 1000;
const SURVEY_WINDOW_DAYS = 7;

interface IngestStats {
  surveys_inserted: number;
  surveys_updated: number;
  assignments_inserted: number;
  assignments_updated: number;
  completions_matched: number;
  completions_ambiguous: Set<string>;
  completions_unmatched: Set<string>;
  match_confidence_counts: Record<MatchConfidence, number>;
  inactive_pool_skipped: number;
  skipped_other_location: number;
  recomputed: number;
  warnings: string[];
  failures: string[];
}

function newStats(warnings: string[] = []): IngestStats {
  return {
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
    skipped_other_location: 0,
    recomputed: 0,
    warnings,
    failures: [],
  };
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
      console.error("[survey-import]", msg);
      stats.failures.push(msg);
    }
  }
}

/**
 * End-to-end survey ingest for ONE location. Unlike other importers, the
 * survey master CSV is LOCATION-AGNOSTIC (7taps master export covers all
 * locations). Routing happens via fuzzy matching against each location's
 * active employee roster — names that don't resolve to anyone here get
 * skipped naturally. The assignment pool denominator is derived from
 * that location's worked time entries during each survey week.
 *
 * Paginated time-entry fetch per survey week to dodge PostgREST's
 * 1,000-row max-rows truncation.
 */
async function ingestSurveysForLocation(
  supabase: SupabaseServer,
  parsed: SurveyImportResult,
  location: { id: string; name: string; csv_aliases: string[] | null }
): Promise<IngestStats> {
  const stats = newStats();

  // Filter parsed.assignments to those tagged for THIS location (or untagged).
  // Untagged rows (no Location column at all) fall through to the existing
  // "fuzzy match against this location's roster" behavior — same as before.
  // Tagged rows that target a different location get skipped here, which
  // prevents cross-location false matches when a multi-location master CSV
  // is bulk-uploaded.
  const beforeFilter = parsed.assignments.length;
  const locationAssignments = parsed.assignments.filter((a) =>
    rowMatchesLocation(a.location_label, location.name, location.csv_aliases)
  );
  stats.skipped_other_location = beforeFilter - locationAssignments.length;
  if (locationAssignments.length === 0) return stats;

  // Build a thin parsed-shaped wrapper for the rest of the pipeline.
  const filteredParsed: SurveyImportResult = {
    ...parsed,
    assignments: locationAssignments,
    unique_assignments: locationAssignments.length,
  };

  // Active employees at this location — candidate pool for fuzzy matching.
  const { data: locEmployees } = await supabase
    .from("employees")
    .select("id, employee_name, active")
    .eq("location_id", location.id)
    .eq("active", true);
  const candidates: EmployeeCandidate[] = (locEmployees ?? []).map((e) => ({
    id: e.id,
    employee_name: e.employee_name,
  }));
  const activeIds = new Set<string>(candidates.map((c) => c.id));
  if (candidates.length === 0) return stats;

  // ---- Phase 1: catalog of unique surveys mentioned in the CSV ----
  type SurveyKey = string; // `${titleLower}|${sentDate ?? ""}`
  const surveyMap = new Map<
    SurveyKey,
    { title: string; sent_date: string | null; external_survey_id: string | null }
  >();
  for (const a of filteredParsed.assignments) {
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

  // Pre-fetch existing surveys at this location (paginated).
  const existingSurveyKey = new Map<string, string>();
  {
    let from = 0;
    while (true) {
      const { data: page } = await supabase
        .from("surveys")
        .select("id, title, sent_date")
        .eq("location_id", location.id)
        .range(from, from + FETCH_PAGE - 1);
      if (!page || page.length === 0) break;
      for (const s of page) {
        const k = `${(s.title as string).toLowerCase()}|${(s.sent_date as string | null) ?? ""}`;
        existingSurveyKey.set(k, s.id as string);
      }
      if (page.length < FETCH_PAGE) break;
      from += FETCH_PAGE;
    }
  }
  for (const k of surveyMap.keys()) {
    if (existingSurveyKey.has(k)) stats.surveys_updated += 1;
    else stats.surveys_inserted += 1;
  }

  const surveyPayloads = Array.from(surveyMap.values()).map((s) => ({
    location_id: location.id,
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
    stats
  );

  // Get fresh survey IDs (paginated).
  const surveyIdByKey = new Map<string, string>();
  {
    let from = 0;
    while (true) {
      const { data: page } = await supabase
        .from("surveys")
        .select("id, title, sent_date")
        .eq("location_id", location.id)
        .range(from, from + FETCH_PAGE - 1);
      if (!page || page.length === 0) break;
      for (const s of page) {
        const k = `${(s.title as string).toLowerCase()}|${(s.sent_date as string | null) ?? ""}`;
        surveyIdByKey.set(k, s.id as string);
      }
      if (page.length < FETCH_PAGE) break;
      from += FETCH_PAGE;
    }
  }

  // ---- Phase 2: fuzzy match completions to this location's roster ----
  const completionsBySurvey = new Map<
    string,
    Map<string, { completion_date: string | null; response_data: unknown }>
  >();

  for (const a of filteredParsed.assignments) {
    if (!a.completed) continue;
    const surveyKey = `${a.survey_title.toLowerCase()}|${a.sent_date ?? ""}`;
    const result = fuzzyMatchEmployee(a.employee_name_display, candidates);
    stats.match_confidence_counts[result.confidence] += 1;

    if (!result.match) {
      if (result.confidence === "ambiguous") {
        stats.completions_ambiguous.add(
          `${a.employee_name_display} (could be: ${result.candidates_considered?.map((c) => c.employee_name).join(", ")})`
        );
      } else {
        stats.completions_unmatched.add(a.employee_name_display);
      }
      continue;
    }

    stats.completions_matched += 1;
    let map = completionsBySurvey.get(surveyKey);
    if (!map) {
      map = new Map();
      completionsBySurvey.set(surveyKey, map);
    }
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

  // ---- Phase 3: derive assignment pools from time_entries per survey ----
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
      stats.warnings.push(
        `Survey "${surveyMeta.title}" @ ${location.name} has no sent_date — assignment pool not derived; only matched completions stored.`
      );
      continue;
    }

    const start = new Date(sentDate + "T00:00:00");
    const end = new Date(start);
    end.setDate(end.getDate() + (SURVEY_WINDOW_DAYS - 1));
    const endIso = end.toISOString().slice(0, 10);

    // Paginated worked-entry fetch for this 7-day window.
    const workedEmps = new Set<string>();
    {
      let from = 0;
      while (true) {
        const { data: page } = await supabase
          .from("time_entries")
          .select("employee_id")
          .eq("location_id", location.id)
          .eq("entry_type", "worked")
          .gte("entry_date", sentDate)
          .lte("entry_date", endIso)
          .range(from, from + FETCH_PAGE - 1);
        if (!page || page.length === 0) break;
        for (const e of page) workedEmps.add(e.employee_id as string);
        if (page.length < FETCH_PAGE) break;
        from += FETCH_PAGE;
      }
    }

    const completions = completionsBySurvey.get(surveyKey) ?? new Map();
    const pool = new Set<string>();
    for (const empId of workedEmps) {
      if (activeIds.has(empId)) pool.add(empId);
      else stats.inactive_pool_skipped += 1;
    }
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

  // Pre-fetch existing assignments (paginated) for accurate insert/update counts.
  const touchedSurveyIds = Array.from(new Set(Array.from(surveyIdByKey.values())));
  const existingKeys = new Set<string>();
  if (touchedSurveyIds.length > 0) {
    for (let i = 0; i < touchedSurveyIds.length; i += 500) {
      const chunkIds = touchedSurveyIds.slice(i, i + 500);
      let from = 0;
      while (true) {
        const { data: page } = await supabase
          .from("survey_assignments")
          .select("survey_id, employee_id")
          .in("survey_id", chunkIds)
          .range(from, from + FETCH_PAGE - 1);
        if (!page || page.length === 0) break;
        for (const r of page) {
          existingKeys.add(`${r.survey_id}|${r.employee_id}`);
        }
        if (page.length < FETCH_PAGE) break;
        from += FETCH_PAGE;
      }
    }
  }
  for (const a of assignmentPayloads) {
    const key = `${a.survey_id}|${a.employee_id}`;
    if (existingKeys.has(key)) stats.assignments_updated += 1;
    else stats.assignments_inserted += 1;
    existingKeys.add(key);
  }

  await chunkOp(
    async (batch: typeof assignmentPayloads) =>
      await supabase
        .from("survey_assignments")
        .upsert(batch, { onConflict: "survey_id,employee_id" }),
    assignmentPayloads,
    "survey_assignments",
    stats
  );

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

export async function uploadSurveyCsvAction(formData: FormData) {
  console.log("[survey-import] uploadSurveyCsvAction invoked");

  await runSingleUpload({
    formData,
    errorParam: "survey_error",
    parse: parseSurveyCsv,
    fatalParseError: (parsed) =>
      parsed.errors.length > 0 && parsed.assignments.length === 0 ? parsed.errors.join("; ") : null,
    run: async (supabase: SupabaseServer, parsed, location) => {
      const stats = await ingestSurveysForLocation(supabase, parsed, location);
      for (const w of parsed.warnings.slice(0, 10)) stats.warnings.push(w);

      revalidatePath(`/dashboard/locations/${location.id}`);
      revalidatePath("/dashboard/employees");

      const params = new URLSearchParams();
      params.set("survey_in", String(stats.surveys_inserted));
      params.set("survey_up", String(stats.surveys_updated));
      params.set("assn_in", String(stats.assignments_inserted));
      params.set("assn_up", String(stats.assignments_updated));
      params.set("matches", String(stats.completions_matched));
      params.set(
        "match_breakdown",
        `exact=${stats.match_confidence_counts.exact} first=${stats.match_confidence_counts.first_name} tokens=${stats.match_confidence_counts.token_containment} fuzzy=${stats.match_confidence_counts.levenshtein}`
      );
      params.set("survey_recomputed", String(stats.recomputed));
      if (stats.inactive_pool_skipped > 0)
        params.set("survey_inactive_skipped", String(stats.inactive_pool_skipped));
      if (stats.completions_unmatched.size > 0)
        params.set("survey_unmatched", Array.from(stats.completions_unmatched).slice(0, 8).join(", "));
      if (stats.completions_ambiguous.size > 0)
        params.set("survey_ambiguous", Array.from(stats.completions_ambiguous).slice(0, 5).join(" | "));
      if (stats.warnings.length > 0)
        params.set("survey_warnings", stats.warnings.slice(0, 3).join(" | "));
      if (stats.failures.length > 0)
        params.set("survey_failures", stats.failures.slice(0, 3).join(" | "));
      return params;
    },
  });
}

/**
 * Bulk: fan out the survey master CSV across many locations
 * (scope=client | scope=all). Each location's fuzzy matcher only matches
 * its own roster, so non-matching completions get silently skipped per
 * location. Idiomatic when uploading a 7taps consolidated CSV that
 * covers everyone across all locations.
 */
export async function uploadSurveyCsvBulkAction(formData: FormData) {
  console.log("[survey-import] uploadSurveyCsvBulkAction invoked");

  await runBulkUpload({
    formData,
    errorParam: "bulk_survey_error",
    parse: parseSurveyCsv,
    fatalParseError: (parsed) =>
      parsed.errors.length > 0 && parsed.assignments.length === 0 ? parsed.errors.join("; ") : null,
    run: async (supabase: SupabaseServer, parsed, targets, { scope, client_id }) => {
      const aggregated: IngestStats = newStats();
      const perLocation: Array<{
        name: string;
        surveys_in: number;
        surveys_up: number;
        assn_in: number;
        assn_up: number;
        matched: number;
        recomputed: number;
      }> = [];

      for (const loc of targets) {
        const stats = await ingestSurveysForLocation(supabase, parsed, loc);
        aggregated.surveys_inserted += stats.surveys_inserted;
        aggregated.surveys_updated += stats.surveys_updated;
        aggregated.assignments_inserted += stats.assignments_inserted;
        aggregated.assignments_updated += stats.assignments_updated;
        aggregated.completions_matched += stats.completions_matched;
        for (const k of ["exact", "first_name", "token_containment", "levenshtein", "ambiguous", "none"] as const) {
          aggregated.match_confidence_counts[k] += stats.match_confidence_counts[k];
        }
        aggregated.inactive_pool_skipped += stats.inactive_pool_skipped;
        aggregated.recomputed += stats.recomputed;
        for (const n of stats.completions_unmatched) aggregated.completions_unmatched.add(n);
        for (const n of stats.completions_ambiguous) aggregated.completions_ambiguous.add(n);
        aggregated.failures.push(...stats.failures);
        perLocation.push({
          name: loc.name,
          surveys_in: stats.surveys_inserted,
          surveys_up: stats.surveys_updated,
          assn_in: stats.assignments_inserted,
          assn_up: stats.assignments_updated,
          matched: stats.completions_matched,
          recomputed: stats.recomputed,
        });
      }

      for (const loc of targets) revalidatePath(`/dashboard/locations/${loc.id}`);
      revalidatePath("/dashboard/employees");
      if (scope === "client" && client_id) revalidatePath(`/dashboard/clients/${client_id}`);
      revalidatePath("/dashboard/uploads");

      const params = new URLSearchParams();
      params.set("bulk_survey_locations", String(targets.length));
      params.set("bulk_survey_in", String(aggregated.surveys_inserted));
      params.set("bulk_survey_up", String(aggregated.surveys_updated));
      params.set("bulk_assn_in", String(aggregated.assignments_inserted));
      params.set("bulk_assn_up", String(aggregated.assignments_updated));
      params.set("bulk_survey_matches", String(aggregated.completions_matched));
      params.set("bulk_survey_recomputed", String(aggregated.recomputed));
      const breakdown = perLocation
        .filter((p) => p.surveys_in + p.surveys_up + p.assn_in + p.assn_up > 0)
        .map(
          (p) =>
            `${p.name}: surveys ${p.surveys_in}+${p.surveys_up}u · assn ${p.assn_in}+${p.assn_up}u · matched ${p.matched} · recomputed ${p.recomputed}`
        )
        .join(" | ");
      if (breakdown) params.set("bulk_survey_breakdown", breakdown);
      if (aggregated.failures.length > 0)
        params.set("bulk_survey_failures", aggregated.failures.slice(0, 3).join(" | "));
      return params;
    },
  });
}
