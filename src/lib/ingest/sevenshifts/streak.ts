/**
 * Per-location empty-streak guard for the nightly ingest.
 *
 * decideAlert() (alert.ts) only fires the "uniformly empty" alarm when EVERY
 * run of a source is empty in one night. That never caught NOLA drifting: its
 * 7shifts_time logged `empty` for ~8 nights while HOU/CO time runs had data, so
 * the source was never *uniformly* empty. The result was a silent multi-week
 * gap in NOLA actuals (decisions-log-cake-ingest-2026-06-08.md).
 *
 * This guard closes that gap per (location, source): if a pair that ran tonight
 * came back `empty`, look back over its run history and count how many nights in
 * a row it has been empty with no successful pull in between. At/over the
 * threshold it adds a reason to the nightly alert, so the next outage surfaces
 * within a few nights instead of drifting unnoticed.
 *
 * The counter is a pure function (countLeadingEmpty) so it is unit-tested in
 * isolation; the DB lookup (emptyStreakReasons) layers history on top of it.
 */

import type { AdminClient } from "./crosswalk";
import type { IngestStatus, RunOutcome } from "./runs";

/** Consecutive empty nights that trip the alarm (today included). */
export const EMPTY_STREAK_THRESHOLD = 3;

/** How many recent runs to inspect per (location, source). One run/night under
 * the nightly cron, so this comfortably covers a multi-week streak + the prior
 * success used for the "last success" date. */
const HISTORY_LIMIT = 40;

/**
 * Count consecutive `empty` runs from the newest backwards, stopping at the
 * first non-empty status. Input must be ordered newest-first.
 *
 * A `success` (a real recovery) resets the streak; so does any other non-empty
 * status (`error`/`running`) — an error night is its own alert and breaks the
 * "silent empty drift" pattern this guard is built to catch. Tonight's run is
 * expected to be the first element, so the returned count includes today.
 */
export function countLeadingEmpty(statusesNewestFirst: IngestStatus[]): number {
  let streak = 0;
  for (const status of statusesNewestFirst) {
    if (status !== "empty") break;
    streak += 1;
  }
  return streak;
}

/**
 * For every (location, source) that ran tonight and came back `empty`, count its
 * consecutive-empty streak from ingest_runs and, if it is at/over the threshold,
 * return a human reason string for the alert (with the last successful date).
 *
 * Tonight's empty run is already persisted (finishRun precedes alert assembly),
 * so it is included in the history and the streak count. Never throws — a failed
 * lookup is logged and that pair is skipped, mirroring the rest of the ingest
 * path where ingest_runs is the durable source of truth.
 */
export async function emptyStreakReasons(
  supabase: AdminClient,
  outcomes: RunOutcome[]
): Promise<string[]> {
  const reasons: string[] = [];

  for (const o of outcomes) {
    if (o.status !== "empty") continue;

    const { data, error } = await supabase
      .from("ingest_runs")
      .select("status, started_at")
      .eq("source", o.source)
      .eq("location_id", o.location_id)
      .order("started_at", { ascending: false })
      .limit(HISTORY_LIMIT);

    if (error) {
      console.warn(
        `[ingest/streak] history lookup failed (${o.source}/${o.location_code}): ${error.message}`
      );
      continue;
    }

    const rows = data ?? [];
    const streak = countLeadingEmpty(rows.map((r) => r.status as IngestStatus));
    if (streak < EMPTY_STREAK_THRESHOLD) continue;

    const lastSuccess = rows.find((r) => r.status === "success");
    const lastSuccessDate = lastSuccess?.started_at
      ? String(lastSuccess.started_at).slice(0, 10)
      : "never";

    reasons.push(
      `${o.location_code} ${o.source} empty ${streak} nights (last success ${lastSuccessDate})`
    );
  }

  return reasons;
}
