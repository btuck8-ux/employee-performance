import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * THE single writer for performance_records.manager_feedback (kickoff
 * 2026-08-19 §3 build note: one writer, never two). Used by the profile's
 * edit action and the Reports-builder pre-generation save.
 *
 * A DB trigger on this column flips feedback_updated_after_generation = true
 * on every non-superseded generated_reports row for the period — including
 * task-detail reports. That's why this helper is CHANGE-DETECTING: writing an
 * identical value would spuriously stale-flag reports that faithfully show
 * the current text. `updated_at` on the record is the audit surface (per the
 * packet; no new DDL).
 *
 * `text` semantics: caller passes the resolved value — a trimmed non-empty
 * string, or null to clear. "Empty means don't touch" policies (the builder's)
 * belong in the caller, not here.
 */
export async function writeManagerFeedback(
  supabase: SupabaseClient,
  performanceRecordId: string,
  text: string | null
): Promise<{ ok: boolean; changed: boolean; error?: string }> {
  const { data: current, error: readErr } = await supabase
    .from("performance_records")
    .select("manager_feedback")
    .eq("id", performanceRecordId)
    .single();
  if (readErr || !current) {
    return { ok: false, changed: false, error: readErr?.message ?? "record not found" };
  }
  const stored = (current.manager_feedback as string | null) ?? null;
  if (stored === text) return { ok: true, changed: false };

  const { error } = await supabase
    .from("performance_records")
    .update({ manager_feedback: text })
    .eq("id", performanceRecordId);
  if (error) return { ok: false, changed: false, error: error.message };
  return { ok: true, changed: true };
}
