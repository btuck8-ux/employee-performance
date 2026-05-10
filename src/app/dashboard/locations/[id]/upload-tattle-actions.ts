"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  parseTattleCsv,
  type ParsedTattleSurvey,
  type TattleImportResult,
} from "@/lib/tattle-import";
import { recomputePerformanceForQuarter } from "@/lib/performance-recompute";
import { quarterOfDate, type Quarter } from "@/lib/quarter";
import { rowMatchesLocation } from "@/lib/location-match";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

const UPSERT_BATCH_SIZE = 250;

interface AttributionContext {
  workedByDate: Map<
    string,
    { employee_id: string; in_time: string | null; out_time: string | null }[]
  >;
}

interface IngestStats {
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

function newStats(warnings: string[] = []): IngestStats {
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
async function ingestTattlesForLocation(
  supabase: SupabaseServer,
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
  const { data: workedEntries } = await supabase
    .from("time_entries")
    .select("employee_id, entry_date, in_time, out_time")
    .eq("location_id", location.id)
    .eq("entry_type", "worked")
    .range(0, 99999);
  const ctx: AttributionContext = { workedByDate: new Map() };
  for (const e of workedEntries ?? []) {
    const list = ctx.workedByDate.get(e.entry_date as string);
    const item = {
      employee_id: e.employee_id as string,
      in_time: e.in_time as string | null,
      out_time: e.out_time as string | null,
    };
    if (list) list.push(item);
    else ctx.workedByDate.set(e.entry_date as string, [item]);
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

export async function uploadTattleCsvAction(formData: FormData) {
  console.log("[tattle-import] uploadTattleCsvAction invoked");

  const location_id = String(formData.get("location_id") ?? "");
  const file = formData.get("file") as File | null;

  if (!location_id) {
    redirect(`/dashboard/locations?tattle_error=${encodeURIComponent("Missing location.")}`);
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
      `/dashboard/locations/${location_id}?tattle_error=${encodeURIComponent(parsed.errors.join("; "))}`
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

  const stats = await ingestTattlesForLocation(supabase, parsed, location);
  // Surface parser warnings too (they're independent of per-location stats).
  for (const w of parsed.warnings.slice(0, 10)) stats.warnings.push(w);

  console.log(
    `[tattle-import] ${location.name}: surveys ${stats.surveys_inserted}+${stats.surveys_updated}u, ` +
      `responses=${stats.responses_upserted}, attributions=${stats.attributions_inserted}, ` +
      `recomputed=${stats.recomputed}, skipped_other=${stats.skipped_other_location}`
  );

  revalidatePath(`/dashboard/locations/${location_id}`);
  revalidatePath("/dashboard/employees");

  const params = new URLSearchParams();
  params.set("tattle_in", String(stats.surveys_inserted));
  params.set("tattle_up", String(stats.surveys_updated));
  params.set("tattle_resp", String(stats.responses_upserted));
  params.set("tattle_att", String(stats.attributions_inserted));
  params.set("tattle_onshift", String(stats.attribution_method_counts.on_shift_at_experienced));
  params.set("tattle_workday", String(stats.attribution_method_counts.worked_that_day));
  params.set("tattle_unatt", String(stats.attribution_method_counts.none));
  params.set("tattle_recomputed", String(stats.recomputed));
  if (stats.skipped_other_location > 0)
    params.set("tattle_skipped_other_location", String(stats.skipped_other_location));
  if (stats.warnings.length > 0)
    params.set("tattle_warnings", stats.warnings.slice(0, 3).join(" | "));
  if (stats.failures.length > 0)
    params.set("tattle_failures", stats.failures.slice(0, 3).join(" | "));

  redirect(`/dashboard/locations/${location_id}?${params.toString()}`);
}

/**
 * Bulk: fan out a tattle CSV across many locations (scope=client | scope=all).
 * Each location runs its own filter (by Location column), upsert, attribution,
 * and recompute. Per-location breakdown surfaces in the result banner.
 */
export async function uploadTattleCsvBulkAction(formData: FormData) {
  console.log("[tattle-import] uploadTattleCsvBulkAction invoked");

  const scope = String(formData.get("scope") ?? "all") as "client" | "all";
  const client_id = scope === "client" ? String(formData.get("client_id") ?? "") : null;
  const file = formData.get("file") as File | null;

  const redirectBase =
    scope === "client" && client_id
      ? `/dashboard/clients/${client_id}`
      : `/dashboard/uploads`;

  if (!file || file.size === 0) {
    redirect(`${redirectBase}?bulk_tattle_error=${encodeURIComponent("No file uploaded.")}`);
  }

  const supabase = await createClient();
  const text = await file.text();
  const parsed = parseTattleCsv(text);

  if (parsed.errors.length > 0 && parsed.surveys.length === 0) {
    redirect(
      `${redirectBase}?bulk_tattle_error=${encodeURIComponent(parsed.errors.join("; "))}`
    );
  }

  // Resolve target locations (with their csv_aliases for matching).
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
      `${redirectBase}?bulk_tattle_error=${encodeURIComponent(
        scope === "client" ? "No locations under this client." : "No locations exist yet."
      )}`
    );
  }

  // Aggregate stats across all targets.
  const aggregated: IngestStats = newStats();
  const perLocation: Array<{
    name: string;
    surveys_in: number;
    surveys_up: number;
    attributions: number;
    recomputed: number;
  }> = [];

  for (const loc of targets) {
    const stats = await ingestTattlesForLocation(supabase, parsed, loc);
    aggregated.surveys_inserted += stats.surveys_inserted;
    aggregated.surveys_updated += stats.surveys_updated;
    aggregated.responses_upserted += stats.responses_upserted;
    aggregated.attributions_inserted += stats.attributions_inserted;
    aggregated.attribution_method_counts.on_shift_at_experienced +=
      stats.attribution_method_counts.on_shift_at_experienced;
    aggregated.attribution_method_counts.worked_that_day +=
      stats.attribution_method_counts.worked_that_day;
    aggregated.attribution_method_counts.none += stats.attribution_method_counts.none;
    aggregated.skipped_other_location += stats.skipped_other_location;
    aggregated.recomputed += stats.recomputed;
    aggregated.failures.push(...stats.failures);
    perLocation.push({
      name: loc.name,
      surveys_in: stats.surveys_inserted,
      surveys_up: stats.surveys_updated,
      attributions: stats.attributions_inserted,
      recomputed: stats.recomputed,
    });
  }

  // Compute true unmatched count: rows whose location_label matches NO target
  // name AND no target alias.
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
  for (const s of parsed.surveys) {
    const lbl = (s.location_label ?? "").trim().toLowerCase();
    if (lbl && !targetNames.has(lbl)) trulyUnmatched += 1;
  }

  // Revalidate every touched location.
  for (const loc of targets) revalidatePath(`/dashboard/locations/${loc.id}`);
  revalidatePath("/dashboard/employees");
  if (scope === "client" && client_id) revalidatePath(`/dashboard/clients/${client_id}`);
  revalidatePath("/dashboard/uploads");

  console.log(
    `[tattle-import] BULK DONE across ${targets.length} locations: ` +
      `surveys=${aggregated.surveys_inserted}+${aggregated.surveys_updated}u, ` +
      `attributions=${aggregated.attributions_inserted}, recomputed=${aggregated.recomputed}, ` +
      `unmatched=${trulyUnmatched}, failures=${aggregated.failures.length}`
  );

  const params = new URLSearchParams();
  params.set("bulk_tattle_locations", String(targets.length));
  params.set("bulk_tattle_in", String(aggregated.surveys_inserted));
  params.set("bulk_tattle_up", String(aggregated.surveys_updated));
  params.set("bulk_tattle_resp", String(aggregated.responses_upserted));
  params.set("bulk_tattle_att", String(aggregated.attributions_inserted));
  params.set(
    "bulk_tattle_onshift",
    String(aggregated.attribution_method_counts.on_shift_at_experienced)
  );
  params.set(
    "bulk_tattle_workday",
    String(aggregated.attribution_method_counts.worked_that_day)
  );
  params.set("bulk_tattle_unatt", String(aggregated.attribution_method_counts.none));
  params.set("bulk_tattle_recomputed", String(aggregated.recomputed));
  params.set("bulk_tattle_unmatched", String(trulyUnmatched));
  const breakdown = perLocation
    .filter((p) => p.surveys_in + p.surveys_up + p.attributions > 0)
    .map(
      (p) =>
        `${p.name}: surveys ${p.surveys_in}+${p.surveys_up}u · att ${p.attributions} · recomputed ${p.recomputed}`
    )
    .join(" | ");
  if (breakdown) params.set("bulk_tattle_breakdown", breakdown);
  if (aggregated.failures.length > 0)
    params.set("bulk_tattle_failures", aggregated.failures.slice(0, 3).join(" | "));

  redirect(`${redirectBase}?${params.toString()}`);
}
