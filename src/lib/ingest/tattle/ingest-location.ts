/**
 * Per-location Tattle ingest — pure compute, no redirect/revalidate.
 *
 * Extracted from upload-tattle-actions.ts so BOTH the manual CSV upload action
 * and the automated guest-feedback harvester run the identical filter → upsert →
 * attribute-against-worked-time → recompute path. The move was deliberate: keep
 * one code path so manual and automated stay in lockstep (handoff §1).
 *
 * Accepts any SupabaseClient — the SSR server client (upload action) and the
 * service-role admin client (harvester) are both structurally SupabaseClient.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type ParsedTattleSurvey,
  type TattleImportResult,
} from "@/lib/tattle-import";
import { recomputePerformanceForQuarter } from "@/lib/performance-recompute";
import { fetchCustomerServiceWeights } from "@/lib/customer-service-score";
import { fetchTotalImpactWeights } from "@/lib/total-impact-score";
import { quarterOfDate, type Quarter } from "@/lib/quarter";
import { rowMatchesLocation } from "@/lib/location-match";

const UPSERT_BATCH_SIZE = 250;

interface AttributionContext {
  workedByDate: Map<
    string,
    { employee_id: string; in_time: string | null; out_time: string | null }[]
  >;
}

export interface IngestStats {
  surveys_inserted: number;
  surveys_updated: number;
  responses_upserted: number;
  attributions_inserted: number;
  attribution_method_counts: Record<
    "on_shift_at_experienced" | "worked_that_day" | "none",
    number
  >;
  skipped_other_location: number;
  recomputed: number;
  warnings: string[];
  failures: string[];
}

export function newStats(warnings: string[] = []): IngestStats {
  return {
    surveys_inserted: 0,
    surveys_updated: 0,
    responses_upserted: 0,
    attributions_inserted: 0,
    attribution_method_counts: {
      on_shift_at_experienced: 0,
      worked_that_day: 0,
      none: 0,
    },
    skipped_other_location: 0,
    recomputed: 0,
    warnings,
    failures: [],
  };
}

/** Decide which employees to attribute a survey to. */
function attributeSurvey(
  survey: ParsedTattleSurvey,
  ctx: AttributionContext
): { employee_id: string; method: "on_shift_at_experienced" | "worked_that_day" }[] {
  if (!survey.date_experienced) return [];
  const dayShifts = ctx.workedByDate.get(survey.date_experienced) ?? [];
  if (dayShifts.length === 0) return [];

  let onShift: typeof dayShifts = [];
  if (survey.datetime_experienced) {
    const expTime = survey.datetime_experienced.slice(11, 19);
    onShift = dayShifts.filter((s) => {
      if (!s.in_time || !s.out_time) return false;
      return s.in_time <= expTime && expTime <= s.out_time;
    });
  }

  if (onShift.length > 0) {
    return onShift.map((s) => ({
      employee_id: s.employee_id,
      method: "on_shift_at_experienced" as const,
    }));
  }
  return dayShifts.map((s) => ({
    employee_id: s.employee_id,
    method: "worked_that_day" as const,
  }));
}

async function chunkUpsert<T>(
  upsertFn: (batch: T[]) => Promise<{ error: { message: string } | null }>,
  rows: T[],
  label: string,
  stats: IngestStats
) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await upsertFn(batch);
    if (error) {
      const msg = `${label} batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}: ${error.message}`;
      console.error("[tattle-import]", msg);
      stats.failures.push(msg);
    }
  }
}

/**
 * End-to-end tattle ingest for ONE location: filter surveys by location.name,
 * upsert surveys + responses, run attribution against worked time entries at
 * this location, recompute affected (employee, quarter). Returns stats.
 *
 * Pure compute (no redirect / revalidate) so it's reusable by the per-location
 * action and the multi-location fan-out action.
 */
export async function ingestTattlesForLocation(
  supabase: SupabaseClient,
  parsed: TattleImportResult,
  location: { id: string; name: string; csv_aliases: string[] | null }
): Promise<IngestStats> {
  const stats = newStats();

  // Filter to surveys tagged for THIS location (or untagged), checking the
  // canonical name AND every csv_aliases entry for vendor naming variants.
  const beforeFilter = parsed.surveys.length;
  const locationSurveys = parsed.surveys.filter((s) =>
    rowMatchesLocation(s.location_label, location.name, location.csv_aliases)
  );
  stats.skipped_other_location = beforeFilter - locationSurveys.length;
  if (locationSurveys.length === 0) {
    console.log(
      `[tattle-import] ${location.name}: nothing to ingest (${stats.skipped_other_location} skipped)`
    );
    return stats;
  }

  // Build attribution context from this location's worked time entries.
  // Two key behaviors here:
  //   1. Only fetch entries on dates that surveys actually reference. For
  //      a 2,000-row CSV that lands ~200 unique survey dates, we pull
  //      maybe 5-10 worked entries per date = under 2k rows total, well
  //      below the PostgREST max-rows cap. Without this filter, large
  //      locations (1,500+ worked entries) hit the cap and lose entries
  //      silently — that was the original cause of the 558 unattributed
  //      surveys at Highlands Ranch / Central Park / etc.
  //   2. Paginate defensively in case a single location's worked entries
  //      on the relevant dates still exceed 1000 (shouldn't, but safe).
  const surveyDates = Array.from(
    new Set(
      locationSurveys
        .map((s) => s.date_experienced)
        .filter((d): d is string => Boolean(d))
    )
  );
  const ctx: AttributionContext = { workedByDate: new Map() };
  if (surveyDates.length > 0) {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data: pageRows, error: pageErr } = await supabase
        .from("time_entries")
        .select("employee_id, entry_date, in_time, out_time")
        .eq("location_id", location.id)
        .eq("entry_type", "worked")
        .in("entry_date", surveyDates)
        .range(from, from + PAGE - 1);
      if (pageErr) {
        stats.failures.push(`fetch worked entries: ${pageErr.message}`);
        break;
      }
      if (!pageRows || pageRows.length === 0) break;
      for (const e of pageRows) {
        const list = ctx.workedByDate.get(e.entry_date as string);
        const item = {
          employee_id: e.employee_id as string,
          in_time: e.in_time as string | null,
          out_time: e.out_time as string | null,
        };
        if (list) list.push(item);
        else ctx.workedByDate.set(e.entry_date as string, [item]);
      }
      if (pageRows.length < PAGE) break;
      from += PAGE;
    }
  }

  // Pre-fetch existing surveys at this location for insert/update counts.
  const { data: existingSurveys } = await supabase
    .from("tattle_surveys")
    .select("id, external_tattle_id")
    .eq("location_id", location.id)
    .range(0, 99999);
  const existingByTattleId = new Map<string, string>();
  for (const s of existingSurveys ?? []) {
    existingByTattleId.set(s.external_tattle_id as string, s.id as string);
  }

  // ---- Phase 1: upsert tattle_surveys ----
  const surveyPayloads = locationSurveys.map((s) => ({
    location_id: location.id,
    external_tattle_id: s.external_tattle_id,
    external_survey_id: s.external_survey_id,
    external_location_id: s.external_location_id,
    datetime_experienced: s.datetime_experienced,
    date_experienced: s.date_experienced,
    datetime_created: s.datetime_created,
    tattle_rating: s.tattle_rating,
    tattle_score: s.tattle_score,
    food_quality_score: s.food_quality_score,
    accuracy_score: s.accuracy_score,
    speed_of_service_score: s.speed_of_service_score,
    comments_combined: s.comments_combined,
    positive_factors_combined: s.positive_factors_combined,
    negative_factors_combined: s.negative_factors_combined,
  }));
  for (const s of locationSurveys) {
    if (existingByTattleId.has(s.external_tattle_id)) stats.surveys_updated += 1;
    else stats.surveys_inserted += 1;
  }
  await chunkUpsert(
    async (batch: typeof surveyPayloads) =>
      await supabase
        .from("tattle_surveys")
        .upsert(batch, { onConflict: "location_id,external_tattle_id" }),
    surveyPayloads,
    "tattle_surveys",
    stats
  );

  // Get fresh survey IDs (incl. inserted ones).
  const { data: nowSurveys } = await supabase
    .from("tattle_surveys")
    .select("id, external_tattle_id, date_experienced, datetime_experienced")
    .eq("location_id", location.id)
    .range(0, 99999);
  const surveyIdByTattleId = new Map<
    string,
    { id: string; date: string | null; datetime: string | null }
  >();
  for (const s of nowSurveys ?? []) {
    surveyIdByTattleId.set(s.external_tattle_id as string, {
      id: s.id as string,
      date: s.date_experienced as string | null,
      datetime: (s.datetime_experienced as string | null) ?? null,
    });
  }

  // ---- Phase 2: upsert tattle_responses ----
  const responsePayloads: Array<{
    tattle_survey_id: string;
    category: string;
    weight: number | null;
    comment: string | null;
    positive_factors: string | null;
    negative_factors: string | null;
    raw_row: unknown;
  }> = [];
  for (const s of locationSurveys) {
    const surveyRef = surveyIdByTattleId.get(s.external_tattle_id);
    if (!surveyRef) continue;
    for (const r of s.responses) {
      responsePayloads.push({
        tattle_survey_id: surveyRef.id,
        category: r.category,
        weight: r.weight,
        comment: r.comment,
        positive_factors: r.positive_factors,
        negative_factors: r.negative_factors,
        raw_row: r.raw_row,
      });
    }
  }
  await chunkUpsert(
    async (batch: typeof responsePayloads) =>
      await supabase
        .from("tattle_responses")
        .upsert(batch, { onConflict: "tattle_survey_id,category" }),
    responsePayloads,
    "tattle_responses",
    stats
  );
  stats.responses_upserted = responsePayloads.length;

  // ---- Phase 3: compute and upsert attributions ----
  const attributionPayloads: Array<{
    tattle_survey_id: string;
    employee_id: string;
    attribution_method: "on_shift_at_experienced" | "worked_that_day";
  }> = [];
  const affectedKeys = new Set<string>();
  for (const s of locationSurveys) {
    const surveyRef = surveyIdByTattleId.get(s.external_tattle_id);
    if (!surveyRef || !surveyRef.date) continue;
    const att = attributeSurvey(s, ctx);
    if (att.length === 0) {
      stats.attribution_method_counts.none += 1;
      continue;
    }
    for (const a of att) {
      attributionPayloads.push({
        tattle_survey_id: surveyRef.id,
        employee_id: a.employee_id,
        attribution_method: a.method,
      });
      stats.attribution_method_counts[a.method] += 1;
      const q = quarterOfDate(new Date(surveyRef.date));
      affectedKeys.add(`${a.employee_id}|${q.year}|${q.quarter}`);
    }
  }

  // Replace attributions for the imported survey IDs (re-import idempotent).
  const importedSurveyIds = locationSurveys
    .map((s) => surveyIdByTattleId.get(s.external_tattle_id)?.id)
    .filter((x): x is string => Boolean(x));
  if (importedSurveyIds.length > 0) {
    for (let i = 0; i < importedSurveyIds.length; i += 500) {
      const chunk = importedSurveyIds.slice(i, i + 500);
      const { error: delErr } = await supabase
        .from("tattle_attributions")
        .delete()
        .in("tattle_survey_id", chunk);
      if (delErr) {
        stats.failures.push(`delete attributions: ${delErr.message}`);
      }
    }
  }
  await chunkUpsert(
    async (batch: typeof attributionPayloads) =>
      await supabase.from("tattle_attributions").insert(batch),
    attributionPayloads,
    "tattle_attributions",
    stats
  );
  stats.attributions_inserted = attributionPayloads.length;

  // ---- Phase 4: recompute performance for affected (employee, quarter) ----
  const csWeights = await fetchCustomerServiceWeights(supabase);
  const tisWeights = await fetchTotalImpactWeights(supabase);
  for (const key of affectedKeys) {
    const [employee_id, yearStr, quarterStr] = key.split("|");
    const year = parseInt(yearStr, 10);
    const quarter = parseInt(quarterStr, 10) as Quarter;
    const result = await recomputePerformanceForQuarter(
      supabase,
      employee_id,
      location.id,
      year,
      quarter,
      { csWeights, tisWeights }
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
