/**
 * Server-safe time-window primitives shared by the TimeWindowPicker (client)
 * and the server pages that seed its initial window (employee profile,
 * location rankings).
 *
 * ⚠️ This file must NOT carry "use client". It was split out of
 * TimeWindowPicker.tsx (2026-08-17) because Next 16 turns every export of a
 * "use client" module into a client reference: a server component may render
 * such an export as a Component, but CALLING one as a plain function throws
 * "Attempted to call resolveQuarterWindow() from the server" at request time
 * — which is exactly how employee profiles with tip/TIS data (and the
 * rankings page) were dying to a 404/error page in prod. Pinned by
 * src/lib/server-client-boundary-contract.test.ts.
 */

export type TimeWindowMode = "quarter" | "all_time" | "custom";

export interface TimeWindow {
  mode: TimeWindowMode;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  label: string;
  /** When mode === "quarter", the selected period's id (useful as a cache key) */
  quarterId?: string;
}

export interface QuarterOption {
  id: string;
  label: string;
  period_start: string;
  period_end: string;
}

export const todayIso = () => new Date().toISOString().slice(0, 10);

export function resolveQuarterWindow(q: QuarterOption): TimeWindow {
  return {
    mode: "quarter",
    startDate: q.period_start,
    endDate: q.period_end,
    label: q.label,
    quarterId: q.id,
  };
}

export function resolveAllTimeWindow(
  earliestDate: string | null,
  latestDate: string | null
): TimeWindow {
  const start = earliestDate ?? todayIso();
  const end = latestDate ?? todayIso();
  return {
    mode: "all_time",
    startDate: start,
    endDate: end,
    label: "All time",
  };
}

export function resolveCustomWindow(start: string, end: string): TimeWindow {
  return {
    mode: "custom",
    startDate: start,
    endDate: end,
    label: `${start} → ${end}`,
  };
}
