/**
 * Read-only client for the Culture Pulse Supabase project (the direct-read v1
 * of the CP→EPD survey feed, handoff-cp-survey-feed-EXECUTE-2026-07-26.md §3).
 *
 * INTERIM SHAPE, by decision 2026-07-26: EPD holds a CP service-role key as a
 * Sensitive Vercel var and reads CP's tables directly. This breaks the
 * "neither side holds the other's credentials" artery invariant on purpose to
 * ship the data now; the durable form is a CP-served GET /api/survey-feed
 * (CP-repo task, contract specced in the handoff §3). When that lands, this
 * module is the only file to swap.
 *
 * The feed only ever READS: weekly_employee_email_jobs, surveys,
 * survey_responses, employee_directory. Never write to CP from EPD.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Throws (rather than silently no-op) so a missing secret surfaces as an
 * ingest error, not a fake-empty success — same contract as the 7shifts and
 * Toast clients.
 */
function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Culture Pulse env ${name} is not set.`);
  return v;
}

export function createCpClient(): SupabaseClient {
  return createClient(
    requiredEnv("CP_SUPABASE_URL"),
    requiredEnv("CP_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );
}
