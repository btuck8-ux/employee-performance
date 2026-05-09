"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseTattleCsv, type ParsedTattleSurvey } from "@/lib/tattle-import";
import { recomputePerformanceForQuarter } from "@/lib/performance-recompute";
import { quarterOfDate, type Quarter } from "@/lib/quarter";
import { rowMatchesLocation } from "@/lib/location-match";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

const UPSERT_BATCH_SIZE = 250;

interface AttributionContext {
  // worked time entries grouped by date for fast lookup during attribution
  // map: YYYY-MM-DD -> array of { employee_id, in_time, out_time }
  workedByDate: Map<
    string,
    { employee_id: string; in_time: string | null; out_time: string | null }[]
  >;
}

interface ImportSummary {
  surveys_inserted: number;
  surveys_updated: number;
  responses_upserted: number;
  attributions_inserted: number;
  attribution_method_counts: Record<"on_shift_at_experienced" | "worked_that_day" | "none", number>;
  warnings: string[];
  failures: string[];
}

/** Decide which employees to attribute a survey to. Returns array of (employee_id, method). */
function attributeSurvey(
  survey: ParsedTattleSurvey,
  ctx: AttributionContext
): { employee_id: string; method: "on_shift_at_experienced" | "worked_that_day" }[] {
  if (!survey.date_experienced) return [];
  const dayShifts = ctx.workedByDate.get(survey.date_experienced) ?? [];
  if (dayShifts.length === 0) return [];

  // Try to attribute to people on shift at the experienced timestamp.
  let onShift: typeof dayShifts = [];
  if (survey.datetime_experienced) {
    const expTime = survey.datetime_experienced.slice(11, 19); // "HH:MM:SS"
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

  // Fallback: anyone who worked that day.
  return dayShifts.map((s) => ({
    employee_id: s.employee_id,
    method: "worked_that_day" as const,
  }));
}

async function chunkUpsert<T>(
  upsertFn: (batch: T[]) => Promise<{ error: { message: string } | null }>,
  rows: T[],
  label: string,
  summary: ImportSummary
) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await upsertFn(batch);
    if (error) {
      const msg = `${label} batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}: ${error.message}`;
      console.error("[tattle-import]", msg);
      summary.failures.push(msg);
    }
  }
}

export async function uploadTattleCsvAction(formData: FormData) {
  console.log("[tattle-import] uploadTattleCsvAction invoked");

  const location_id = String(formData.get("location_id") ?? "");
  const file = formData.get("file") as File | null;

  if (!location_id) {
    redirect(
      `/dashboard/locations?tattle_error=${encodeURIComponent("Missing location.")}`
    );
  }
  if (!file || file.size === 0) {
    redirect(
      `/dashboard/locations/${location_id}?tattle_error=${encodeURIComponent("No file uploaded.")}`
    );
  }

  const supabase = await createClient();
  const text = await file.text();
  const parsed = parseTattleCsv(text);
  console.log(
    `[tattle-import] parsed ${parsed.rows_in_file} rows -> ${parsed.unique_surveys} unique surveys`
  );

  if (parsed.errors.length > 0 && parsed.surveys.length === 0) {
    redirect(
      `/dashboard/locations/${location_id}?tattle_error=${encodeURIComponent(
        parsed.errors.join("; ")
      )}`
    );
  }

  // ---- Filter out rows tagged for other locations ----
  // Most tattle exports are per-location, but if Tucker uploads an
  // all-locations export, the Location column lets us silently skip
  // rows that belong elsewhere.
  const { data: locRow } = await supabase
    .from("locations")
    .select("name")
    .eq("id", location_id)
    .single();
  const targetLocationName = (locRow?.name as string | undefined) ?? "";
  const beforeFilter = parsed.surveys.length;
  parsed.surveys = parsed.surveys.filter((s) =>
    rowMatchesLocation(s.location_label, targetLocationName)
  );
  const tattleSkippedOtherLocation = beforeFilter - parsed.surveys.length;
  if (tattleSkippedOtherLocation > 0) {
    console.log(
      `[tattle-import] filtered out ${tattleSkippedOtherLocation} surveys tagged for other locations`
    );
  }

  // ---- Build attribution context: worked time entries at this location ----
  const { data: workedEntries } = await supabase
    .from("time_entries")
    .select("employee_id, entry_date, in_time, out_time")
    .eq("location_id", location_id)
    .eq("entry_type", "worked")
    .range(0, 99999);

  const ctx: AttributionContext = { workedByDate: new Map() };
  for (const e of workedEntries ?? []) {
    const list = ctx.workedByDate.get(e.entry_date);
    const item = {
      employee_id: e.employee_id,
      in_time: e.in_time as string | null,
      out_time: e.out_time as string | null,
    };
    if (list) list.push(item);
    else ctx.workedByDate.set(e.entry_date, [item]);
  }
  console.log(
    `[tattle-import] attribution context: ${workedEntries?.length ?? 0} worked entries across ${ctx.workedByDate.size} days`
  );

  // ---- Pre-fetch existing tattle_surveys at this location for insert/update counts ----
  const { data: existingSurveys } = await supabase
    .from("tattle_surveys")
    .select("id, external_tattle_id")
    .eq("location_id", location_id)
    .range(0, 99999);

  const existingByTattleId = new Map<string, string>();
  for (const s of existingSurveys ?? []) {
    existingByTattleId.set(s.external_tattle_id, s.id);
  }

  const summary: ImportSummary = {
    surveys_inserted: 0,
    surveys_updated: 0,
    responses_upserted: 0,
    attributions_inserted: 0,
    attribution_method_counts: { on_shift_at_experienced: 0, worked_that_day: 0, none: 0 },
    warnings: parsed.warnings.slice(0, 10),
    failures: [],
  };

  // ---- Phase 1: bulk upsert tattle_surveys ----
  const surveyPayloads = parsed.surveys.map((s) => ({
    location_id,
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

  for (const s of parsed.surveys) {
    if (existingByTattleId.has(s.external_tattle_id)) summary.surveys_updated += 1;
    else summary.surveys_inserted += 1;
  }

  await chunkUpsert(
    async (batch: typeof surveyPayloads) =>
      await supabase
        .from("tattle_surveys")
        .upsert(batch, { onConflict: "location_id,external_tattle_id" }),
    surveyPayloads,
    "tattle_surveys",
    summary
  );

  // ---- Get the survey IDs back (for FK on responses + attributions) ----
  const { data: nowSurveys } = await supabase
    .from("tattle_surveys")
    .select("id, external_tattle_id, date_experienced, datetime_experienced")
    .eq("location_id", location_id)
    .range(0, 99999);

  const surveyIdByTattleId = new Map<
    string,
    { id: string; date: string | null; datetime: string | null }
  >();
  for (const s of nowSurveys ?? []) {
    surveyIdByTattleId.set(s.external_tattle_id, {
      id: s.id,
      date: s.date_experienced,
      datetime: (s.datetime_experienced as string | null) ?? null,
    });
  }

  // ---- Phase 2: bulk upsert tattle_responses ----
  const responsePayloads: Array<{
    tattle_survey_id: string;
    category: string;
    weight: number | null;
    comment: string | null;
    positive_factors: string | null;
    negative_factors: string | null;
    raw_row: unknown;
  }> = [];

  for (const s of parsed.surveys) {
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
    summary
  );
  summary.responses_upserted = responsePayloads.length;

  // ---- Phase 3: compute and bulk upsert attributions ----
  const attributionPayloads: Array<{
    tattle_survey_id: string;
    employee_id: string;
    attribution_method: "on_shift_at_experienced" | "worked_that_day";
  }> = [];
  const affectedKeys = new Set<string>(); // "employee_id|year|quarter"

  for (const s of parsed.surveys) {
    const surveyRef = surveyIdByTattleId.get(s.external_tattle_id);
    if (!surveyRef || !surveyRef.date) continue;
    const att = attributeSurvey(s, ctx);
    if (att.length === 0) {
      summary.attribution_method_counts.none += 1;
      continue;
    }
    for (const a of att) {
      attributionPayloads.push({
        tattle_survey_id: surveyRef.id,
        employee_id: a.employee_id,
        attribution_method: a.method,
      });
      summary.attribution_method_counts[a.method] += 1;
      // Track which (employee, quarter) needs recompute
      const q = quarterOfDate(new Date(surveyRef.date));
      affectedKeys.add(`${a.employee_id}|${q.year}|${q.quarter}`);
    }
  }

  // Replace attributions for surveys we just imported (in case attribution rules
  // changed or a re-import lands different employees on shift). Cleanest path:
  // delete attributions for the imported survey ids, then insert fresh ones.
  const importedSurveyIds = parsed.surveys
    .map((s) => surveyIdByTattleId.get(s.external_tattle_id)?.id)
    .filter((x): x is string => Boolean(x));

  if (importedSurveyIds.length > 0) {
    // Chunk the delete to avoid too-long .in() filters.
    for (let i = 0; i < importedSurveyIds.length; i += 500) {
      const chunk = importedSurveyIds.slice(i, i + 500);
      const { error: delErr } = await supabase
        .from("tattle_attributions")
        .delete()
        .in("tattle_survey_id", chunk);
      if (delErr) {
        console.error("[tattle-import] delete attributions chunk error:", delErr);
        summary.failures.push(`delete attributions: ${delErr.message}`);
      }
    }
  }

  await chunkUpsert(
    async (batch: typeof attributionPayloads) =>
      await supabase.from("tattle_attributions").insert(batch),
    attributionPayloads,
    "tattle_attributions",
    summary
  );
  summary.attributions_inserted = attributionPayloads.length;

  console.log(
    `[tattle-import] surveys ${summary.surveys_inserted}+${summary.surveys_updated}u, ` +
      `responses=${summary.responses_upserted}, attributions=${summary.attributions_inserted} ` +
      `(on_shift=${summary.attribution_method_counts.on_shift_at_experienced}, ` +
      `worked_day=${summary.attribution_method_counts.worked_that_day}, ` +
      `unattributed=${summary.attribution_method_counts.none})`
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
  console.log(`[tattle-import] recomputed ${recomputed} performance_records`);

  await supabase
    .from("locations")
    .update({ last_data_uploaded_at: new Date().toISOString() })
    .eq("id", location_id);

  revalidatePath(`/dashboard/locations/${location_id}`);
  revalidatePath("/dashboard/employees");

  const params = new URLSearchParams();
  params.set("tattle_in", String(summary.surveys_inserted));
  params.set("tattle_up", String(summary.surveys_updated));
  params.set("tattle_resp", String(summary.responses_upserted));
  params.set("tattle_att", String(summary.attributions_inserted));
  params.set("tattle_onshift", String(summary.attribution_method_counts.on_shift_at_experienced));
  params.set("tattle_workday", String(summary.attribution_method_counts.worked_that_day));
  params.set("tattle_unatt", String(summary.attribution_method_counts.none));
  params.set("tattle_recomputed", String(recomputed));
  if (tattleSkippedOtherLocation > 0)
    params.set("tattle_skipped_other_location", String(tattleSkippedOtherLocation));
  if (summary.warnings.length > 0)
    params.set("tattle_warnings", summary.warnings.slice(0, 3).join(" | "));
  if (summary.failures.length > 0)
    params.set("tattle_failures", summary.failures.slice(0, 3).join(" | "));

  redirect(`/dashboard/locations/${location_id}?${params.toString()}`);
}
