/**
 * CP reads for the survey feed: one location's weekly sends + completions,
 * shaped into CpSurveyWeek[] for the EPD-side resolve + ingest.
 *
 * Source objects (verified live 2026-07-26, CP ref pkjugezverggrcmfylkf):
 *  - Sent (assigned pool): weekly_employee_email_jobs where status='sent' —
 *    the delivered-send log, i.e. the authoritative denominator. CP surveys a
 *    small targeted subset (2–7 people/store/week), which is exactly why the
 *    worked-pool denominator this feed replaces was inflating "assigned".
 *  - Completed: survey_responses (finished_at IS NOT NULL) joined to surveys
 *    for target_monday and to employee_directory for the completer's
 *    name/code.
 *
 * Launch-week caveat: the email-job automation started ~2026-05-18; earlier
 * target_mondays have no job rows. Those weeks fall back to "anyone with a
 * response was at least sent" and are flagged sends_missing so the run log
 * (and the operator) can see the pool is responder-derived.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CpMember, CpSurveyWeek } from "./resolve";

const FETCH_PAGE = 1000;

interface DirectoryRow {
  id: string;
  employee_name: string | null;
  email: string | null;
  employee_code: string | null;
}

async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + FETCH_PAGE - 1);
    if (error) throw new Error(`CP ${label}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < FETCH_PAGE) break;
    from += FETCH_PAGE;
  }
  return out;
}

/**
 * Pull one CP location's survey weeks with target_monday >= sinceIsoDate.
 * Members are deduped per week; a responder not present in the send log is
 * added to the pool (they were evidently sent a survey).
 */
export async function fetchCpSurveyWeeks(
  cp: SupabaseClient,
  cpLocationId: string,
  sinceIsoDate: string
): Promise<CpSurveyWeek[]> {
  // Directory for this location — email/name → code resolution for sends,
  // id → row for responders.
  const directory = await fetchAll<DirectoryRow>(
    (from, to) =>
      cp
        .from("employee_directory")
        .select("id, employee_name, email, employee_code")
        .eq("location_id", cpLocationId)
        .range(from, to),
    "employee_directory"
  );
  const dirById = new Map(directory.map((d) => [d.id, d]));
  const dirByEmail = new Map(
    directory.filter((d) => d.email).map((d) => [d.email!.toLowerCase(), d])
  );
  const dirByName = new Map(
    directory
      .filter((d) => d.employee_name)
      .map((d) => [d.employee_name!.trim().toLowerCase(), d])
  );

  // Delivered sends.
  const jobs = await fetchAll<{
    target_monday: string;
    recipient_name: string | null;
    recipient_email: string | null;
  }>(
    (from, to) =>
      cp
        .from("weekly_employee_email_jobs")
        .select("target_monday, recipient_name, recipient_email")
        .eq("location_id", cpLocationId)
        .eq("status", "sent")
        .gte("target_monday", sinceIsoDate)
        .range(from, to),
    "weekly_employee_email_jobs"
  );

  // Completed responses: CP surveys in window -> finished responses.
  const cpSurveys = await fetchAll<{ id: string; target_monday: string }>(
    (from, to) =>
      cp
        .from("surveys")
        .select("id, target_monday")
        .eq("location_id", cpLocationId)
        .gte("target_monday", sinceIsoDate)
        .range(from, to),
    "surveys"
  );
  const mondayBySurveyId = new Map(cpSurveys.map((s) => [s.id, s.target_monday]));

  const responses =
    cpSurveys.length === 0
      ? []
      : await fetchAll<{ survey_id: string; employee_id: string | null; finished_at: string }>(
          (from, to) =>
            cp
              .from("survey_responses")
              .select("survey_id, employee_id, finished_at")
              .in("survey_id", cpSurveys.map((s) => s.id))
              .not("finished_at", "is", null)
              .range(from, to),
          "survey_responses"
        );

  // Assemble weeks. Key members by directory id when known, else by
  // email/name string, so a send + its response collapse to one member.
  interface WeekAcc {
    members: Map<string, CpMember>;
    had_send_rows: boolean;
  }
  const weeks = new Map<string, WeekAcc>();
  const weekFor = (monday: string): WeekAcc => {
    let w = weeks.get(monday);
    if (!w) {
      w = { members: new Map(), had_send_rows: false };
      weeks.set(monday, w);
    }
    return w;
  };

  for (const j of jobs) {
    const w = weekFor(j.target_monday);
    w.had_send_rows = true;
    const dir =
      (j.recipient_email && dirByEmail.get(j.recipient_email.toLowerCase())) ||
      (j.recipient_name && dirByName.get(j.recipient_name.trim().toLowerCase())) ||
      null;
    const key = dir ? `dir:${dir.id}` : `raw:${(j.recipient_email ?? j.recipient_name ?? "?").toLowerCase()}`;
    if (!w.members.has(key)) {
      w.members.set(key, {
        name: dir?.employee_name ?? j.recipient_name,
        email: dir?.email ?? j.recipient_email,
        employee_code: dir?.employee_code ?? null,
        completed: false,
        completion_date: null,
      });
    }
  }

  for (const r of responses) {
    const monday = mondayBySurveyId.get(r.survey_id);
    if (!monday) continue;
    const w = weekFor(monday);
    const dir = r.employee_id ? (dirById.get(r.employee_id) ?? null) : null;
    const key = dir ? `dir:${dir.id}` : `resp:${r.survey_id}:${r.employee_id ?? "?"}`;
    const completionDate = r.finished_at.slice(0, 10);
    const existing = w.members.get(key);
    if (existing) {
      existing.completed = true;
      if (!existing.completion_date || completionDate < existing.completion_date) {
        existing.completion_date = completionDate;
      }
    } else {
      // Responder absent from the send log — they were evidently sent one.
      w.members.set(key, {
        name: dir?.employee_name ?? null,
        email: dir?.email ?? null,
        employee_code: dir?.employee_code ?? null,
        completed: true,
        completion_date: completionDate,
      });
    }
  }

  return Array.from(weeks.entries())
    .filter(([, w]) => w.members.size > 0)
    .map(([target_monday, w]) => ({
      target_monday,
      members: Array.from(w.members.values()),
      sends_missing: !w.had_send_rows,
    }))
    .sort((a, b) => a.target_monday.localeCompare(b.target_monday));
}
