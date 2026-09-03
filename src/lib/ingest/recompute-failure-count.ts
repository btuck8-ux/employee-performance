/**
 * Count recompute failures for one ingest_runs row, off `detail` — NEVER
 * `error_text` (three sources collapse failures to a summary string there;
 * detail is the ledger, spec §3a).
 *
 * `recompute_failure_count` (2026-09-02) is the exact integer; the
 * `recompute_failures` array is a sample every ingest writer caps at 20
 * (spec §3b), so on legacy rows the array length is a LOWER BOUND. `exact`
 * is false precisely when we fell back to a sample sitting at the cap.
 */

const SAMPLE_CAP = 20;

export interface RecomputeFailureCount {
  count: number;
  /** False when the figure came from a capped sample and may undercount. */
  exact: boolean;
}

export function countRecomputeFailures(
  detail: Record<string, unknown> | null | undefined
): RecomputeFailureCount {
  const exactCount = detail?.recompute_failure_count;
  if (typeof exactCount === "number") return { count: exactCount, exact: true };
  const sample = detail?.recompute_failures;
  const n = Array.isArray(sample) ? sample.length : 0;
  return { count: n, exact: n < SAMPLE_CAP };
}
