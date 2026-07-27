/**
 * CP survey weeks -> EPD surveys + survey_assignments for ONE location.
 *
 * The durable replacement for the worked-pool denominator (handoff-cp-survey-
 * feed-EXECUTE-2026-07-26.md §2): the assigned pool is CP's delivered-send
 * log, the completed set is CP's finished responses — never time_entries.
 * CP surveys a small targeted subset (2–7 people/store/week); deriving the
 * pool from who worked inflated "assigned" to 20–40 and understated
 * engagement.
 *
 * Shares the manual importer's DB contract exactly, so re-syncs reconcile
 * with hand-corrected rows (Houston June) instead of duplicating them:
 *   - surveys upsert on (location_id, title, sent_date), title
 *     'Culture Pulse Weekly' + sent_date = target_monday (the same key the
 *     hand-corrected rows already use — verified live 7/26)
 *   - survey_assignments upsert on (survey_id, employee_id)
 *   - recompute per affected (employee, quarter) — survey engagement is
 *     per-employee (completed/assigned in quarter), so only pool members
 *     recompute (unlike sales, which shift a location-wide baseline)
 *
 * The manual CSV path (ingestSurveysForLocation) stays untouched for any
 * historical 7taps reconciliation.
 */

import { runRecomputeJobs, quarterForDate, type RecomputeJob } from "../sevenshifts/recompute";
import type { AdminClient } from "../sevenshifts/crosswalk";
import {
  buildRosterIndex,
  resolveCpMember,
  type CpSurveyWeek,
  type EpdRosterEmployee,
} from "./resolve";

export const CP_SURVEY_TITLE = "Culture Pulse Weekly";

const UPSERT_BATCH = 250;

export interface CpIngestStats {
  weeks: number;
  surveys_upserted: number;
  assignments_upserted: number;
  completions: number;
  resolved_by_code: number;
  resolved_by_name: number;
  unresolved: string[];
  sends_missing_weeks: string[];
  recomputed: number;
  failures: string[];
}

/**
 * Ingest pre-fetched, per-location CP weeks. Idempotent: both upserts land on
 * natural keys and the recompute is deterministic.
 */
export async function ingestCulturePulseSurveysForLocation(
  supabase: AdminClient,
  location: { id: string; code: string; name: string },
  weeks: CpSurveyWeek[]
): Promise<CpIngestStats> {
  const stats: CpIngestStats = {
    weeks: weeks.length,
    surveys_upserted: 0,
    assignments_upserted: 0,
    completions: 0,
    resolved_by_code: 0,
    resolved_by_name: 0,
    unresolved: [],
    sends_missing_weeks: weeks.filter((w) => w.sends_missing).map((w) => w.target_monday),
    recomputed: 0,
    failures: [],
  };
  if (weeks.length === 0) return stats;

  // Active roster once — code map + fuzzy candidates.
  const { data: roster, error: rosterErr } = await supabase
    .from("employees")
    .select("id, employee_name, employee_code")
    .eq("location_id", location.id)
    .eq("active", true);
  if (rosterErr) throw new Error(`EPD roster load: ${rosterErr.message}`);
  const index = buildRosterIndex((roster ?? []) as EpdRosterEmployee[]);

  // Resolve every week's members to EPD employees, deduped per week.
  interface PoolEntry {
    employee_id: string;
    completed: boolean;
    completion_date: string | null;
  }
  const poolByWeek = new Map<string, Map<string, PoolEntry>>();
  for (const week of weeks) {
    const pool = new Map<string, PoolEntry>();
    for (const m of week.members) {
      const r = resolveCpMember(m, index);
      if (!r.employee_id) {
        const label = `${m.name ?? m.email ?? "?"} (${week.target_monday}, ${r.via})`;
        if (!stats.unresolved.includes(label)) stats.unresolved.push(label);
        continue;
      }
      if (r.via === "code") stats.resolved_by_code += 1;
      else stats.resolved_by_name += 1;

      const prev = pool.get(r.employee_id);
      if (!prev) {
        pool.set(r.employee_id, {
          employee_id: r.employee_id,
          completed: m.completed,
          completion_date: m.completion_date,
        });
      } else {
        // Two CP rows collapsing to one EPD employee: completed wins,
        // earliest completion date kept.
        prev.completed = prev.completed || m.completed;
        if (
          m.completion_date &&
          (!prev.completion_date || m.completion_date < prev.completion_date)
        ) {
          prev.completion_date = m.completion_date;
        }
      }
    }
    if (pool.size > 0) poolByWeek.set(week.target_monday, pool);
  }
  if (poolByWeek.size === 0) return stats;

  // Surveys upsert on (location_id, title, sent_date); source stamped
  // 'culture_pulse' (decision 7/26 — drop the legacy 7taps cosmetic label).
  const surveyPayloads = Array.from(poolByWeek.keys()).map((monday) => ({
    location_id: location.id,
    title: CP_SURVEY_TITLE,
    sent_date: monday,
    source: "culture_pulse",
  }));
  for (let i = 0; i < surveyPayloads.length; i += UPSERT_BATCH) {
    const { error } = await supabase
      .from("surveys")
      .upsert(surveyPayloads.slice(i, i + UPSERT_BATCH), {
        onConflict: "location_id,title,sent_date",
      });
    if (error) throw new Error(`surveys upsert: ${error.message}`);
  }
  stats.surveys_upserted = surveyPayloads.length;

  // Fresh survey ids for the touched weeks.
  const { data: surveyRows, error: surveyErr } = await supabase
    .from("surveys")
    .select("id, sent_date")
    .eq("location_id", location.id)
    .eq("title", CP_SURVEY_TITLE)
    .in("sent_date", Array.from(poolByWeek.keys()));
  if (surveyErr) throw new Error(`surveys readback: ${surveyErr.message}`);
  const surveyIdByMonday = new Map(
    (surveyRows ?? []).map((s) => [s.sent_date as string, s.id as string])
  );

  // Assignments upsert on (survey_id, employee_id).
  const assignmentPayloads: Array<{
    survey_id: string;
    employee_id: string;
    completed: boolean;
    completion_date: string | null;
  }> = [];
  const jobKeys = new Map<string, RecomputeJob>();
  for (const [monday, pool] of poolByWeek) {
    const surveyId = surveyIdByMonday.get(monday);
    if (!surveyId) {
      stats.failures.push(`no survey id after upsert for ${monday} @ ${location.code}`);
      continue;
    }
    const q = quarterForDate(monday);
    for (const entry of pool.values()) {
      assignmentPayloads.push({
        survey_id: surveyId,
        employee_id: entry.employee_id,
        completed: entry.completed,
        completion_date: entry.completion_date,
      });
      if (entry.completed) stats.completions += 1;
      jobKeys.set(`${entry.employee_id}|${q.year}|${q.quarter}`, {
        employee_id: entry.employee_id,
        year: q.year,
        quarter: q.quarter,
      });
    }
  }
  for (let i = 0; i < assignmentPayloads.length; i += UPSERT_BATCH) {
    const { error } = await supabase
      .from("survey_assignments")
      .upsert(assignmentPayloads.slice(i, i + UPSERT_BATCH), {
        onConflict: "survey_id,employee_id",
      });
    if (error) throw new Error(`survey_assignments upsert: ${error.message}`);
  }
  stats.assignments_upserted = assignmentPayloads.length;

  const rc = await runRecomputeJobs(supabase, location.id, Array.from(jobKeys.values()));
  stats.recomputed = rc.recomputed;
  stats.failures.push(...rc.failures);

  if (assignmentPayloads.length > 0) {
    await supabase
      .from("locations")
      .update({ last_data_uploaded_at: new Date().toISOString() })
      .eq("id", location.id);
  }

  return stats;
}
