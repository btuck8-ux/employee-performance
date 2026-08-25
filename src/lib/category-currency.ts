/**
 * Per-category data currency for one location — "data through <date>" for
 * each performance category, scoped to dates <= a period end (handoff
 * 2026-07-27 Part 2).
 *
 * WHY: performance_records carries no per-category as-of date, so a report
 * built on a truncated ingest window looks identical to a full-quarter one.
 * The scoring math is correct — the gap is freshness VISIBILITY. These max
 * source dates feed the report's per-category currency stamps and its
 * staleness banner.
 *
 * A null means the location has NO rows for that category at all (e.g. NOLA
 * sales/guest feedback, by design) — render neutrally, not as an alarm.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface CategoryCurrencyEntry {
  key: "labor" | "sales" | "tattle" | "reviews" | "tasks" | "survey" | "kitchen";
  label: string;
  /** YYYY-MM-DD of the newest source row <= period end, or null if none. */
  data_through: string | null;
}

/** Days behind period_end before a category is flagged stale on the report. */
export const STALE_AFTER_DAYS = 7;

async function maxDate(
  supabase: SupabaseClient,
  table: string,
  dateColumn: string,
  locationId: string,
  maxInclusive: string,
  extraFilter?: { column: string; value: string | boolean }
): Promise<string | null> {
  let q = supabase
    .from(table)
    .select(dateColumn)
    .eq("location_id", locationId)
    .lte(dateColumn, maxInclusive)
    .order(dateColumn, { ascending: false })
    .limit(1);
  if (extraFilter) q = q.eq(extraFilter.column, extraFilter.value);
  const { data, error } = await q.maybeSingle();
  if (error) {
    console.warn(`[category-currency] ${table}.${dateColumn}: ${error.message}`);
    return null;
  }
  const v = (data as Record<string, unknown> | null)?.[dateColumn];
  return v ? String(v).slice(0, 10) : null;
}

/**
 * Compute all seven categories' max source dates for (location, <= periodEnd).
 * Seven small indexed lookups, run concurrently.
 */
export async function getCategoryCurrency(
  supabase: SupabaseClient,
  locationId: string,
  periodEnd: string // YYYY-MM-DD
): Promise<CategoryCurrencyEntry[]> {
  const [laborTe, laborPunch, sales, tattle, reviews, tasks, survey, kitchen] = await Promise.all([
    maxDate(supabase, "time_entries", "entry_date", locationId, periodEnd, {
      column: "entry_type",
      value: "worked",
    }),
    // THE FLIP (2026-08-25): Toast stores' worked evidence lands in
    // toast_time_entries — without this the PDF's labor data-through date
    // freezes at flip day (Codex). Labor currency = the LATEST of the two
    // sources; at non-Toast stores the punch side is simply empty.
    maxDate(supabase, "toast_time_entries", "entry_date", locationId, periodEnd, {
      column: "deleted",
      value: false,
    }),
    // transaction_at is a TZ-free local wall-clock string; the lexical lte
    // against an end-of-day timestamp bounds it to the period.
    maxDate(supabase, "sales_records", "transaction_at", locationId, `${periodEnd}T23:59:59`),
    maxDate(supabase, "tattle_surveys", "date_experienced", locationId, periodEnd),
    maxDate(supabase, "customer_reviews", "review_date", locationId, periodEnd),
    maxDate(supabase, "tasks", "task_date", locationId, periodEnd),
    // Survey currency = the automated CP feed's newest send week; legacy
    // 7taps rows don't reflect the live pipeline's freshness.
    maxDate(supabase, "surveys", "sent_date", locationId, periodEnd, {
      column: "source",
      value: "culture_pulse",
    }),
    // Kitchen history begins at each store's Toast go-live (2026-07), so any
    // earlier period — and every kitchen-disabled store (NOLA) — has no rows
    // and renders the by-design "—", exactly like NOLA's sales.
    maxDate(supabase, "toast_item_fulfillments", "fired_local_date", locationId, periodEnd),
  ]);

  const labor =
    laborTe && laborPunch
      ? laborTe > laborPunch
        ? laborTe
        : laborPunch
      : (laborTe ?? laborPunch);

  return [
    { key: "labor", label: "Labor", data_through: labor },
    { key: "sales", label: "Sales / Tips", data_through: sales },
    { key: "tattle", label: "Tattle", data_through: tattle },
    { key: "reviews", label: "Reviews", data_through: reviews },
    { key: "tasks", label: "Tasks", data_through: tasks },
    { key: "survey", label: "Survey", data_through: survey },
    { key: "kitchen", label: "Kitchen", data_through: kitchen },
  ];
}

/**
 * Categories whose newest data trails the period by > STALE_AFTER_DAYS.
 * Reference point is min(periodEnd, today): a completed quarter expects data
 * through ~period_end, while a mid-quarter report only expects data through
 * ~today — comparing against a future period_end would flag everything.
 */
export function staleCategories(
  entries: CategoryCurrencyEntry[],
  periodEnd: string
): CategoryCurrencyEntry[] {
  const today = new Date().toISOString().slice(0, 10);
  const reference = periodEnd < today ? periodEnd : today;
  const cutoff = new Date(`${reference}T12:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - STALE_AFTER_DAYS);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  return entries.filter((e) => e.data_through !== null && e.data_through < cutoffIso);
}
