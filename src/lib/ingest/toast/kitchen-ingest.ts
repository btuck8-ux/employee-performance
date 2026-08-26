/**
 * Toast Kitchen ingest: normalize -> upsert -> recompute (handoff 2026-07-28
 * §5). Lands per-item fulfillment rows in `toast_item_fulfillments` and
 * triggers the standard per-(employee × quarter) recompute for kitchen-role
 * employees who worked the affected local dates.
 *
 * There is deliberately NO per-ticket attribution table (§6.2): attribution is
 * computed on demand by compute_kitchen_speed() at recompute time — a
 * fulfillment row counts toward an employee iff they were on shift at
 * ticket_fired_at with an is_kitchen role, with NO worked_that_day fallback.
 * An empty kitchen_role_config therefore means zero attribution (safe
 * failure) while store-level rows still accumulate.
 *
 * Timezone (§5.3): ticketFiredAt is UTC; fired_local_date/fired_local_time are
 * projected here with the same utcToLocalWallClock/storeTimezone the
 * labor feed uses, so kitchen rows land on exactly the clock time_entries use.
 *
 * The Step-0 probe (2026-07-28) showed Toast can emit byte-identical duplicate
 * rows (HOU 20260727: 3/452), so each batch dedupes on the natural key before
 * upserting, keeping the latest itemFulfilledAt.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  startRun,
  finishRun,
  type RunOutcome,
} from "../sevenshifts/runs";
import { maybeSendFailureAlert } from "../sevenshifts/alert";
import { emptyStreakReasons } from "../sevenshifts/streak";
import { utcToLocalWallClock, storeTimezone } from "../sevenshifts/tz";
import {
  runRecomputeJobs,
  quarterForDate,
  type RecomputeJob,
} from "../sevenshifts/recompute";
import type { AdminClient } from "../sevenshifts/crosswalk";
import { fetchItemFulfillments, type ItemFulfillment } from "./kitchen";

/** Ceiling on prep_seconds admitted to the aggregates (un-bumped overnight
 * tickets otherwise wreck the mean); rows above it still land, the DB
 * functions exclude them. Probe max was 2105s — ample headroom. */
export const PREP_OUTLIER_SECONDS = 7200;

/** One location's kitchen wiring, read from the migration-041 flags. */
export interface KitchenLocation {
  id: string;
  name: string;
  location_code: string;
  /** locations.timezone — the DB owns the zone; storeTimezone() throws if unset. */
  timezone: string | null;
  /** Null until 042 lands HOU's GUID — such stores are reported, not fetched. */
  toast_restaurant_guid: string | null;
  /** YYYY-MM-DD floor for backfills; kitchen history starts at the store's
   * OWN Toast go-live (toast_sales_start_date) — no constant fallback
   * (§1, addendum 2026-08-25: HOU's real go-live is 2026-04-30, and the old
   * "no sales start date → 2026-07-01" guess was this exact defect). */
  kitchen_start_date: string;
}

export async function loadKitchenCrosswalk(
  supabase: AdminClient
): Promise<KitchenLocation[]> {
  const { data, error } = await supabase
    .from("locations")
    .select(
      "id, name, location_code, timezone, toast_restaurant_guid, toast_sales_start_date, toast_kitchen_enabled"
    )
    .eq("toast_kitchen_enabled", true)
    .order("location_code");
  if (error) throw new Error(`Failed to load kitchen crosswalk: ${error.message}`);
  return (data ?? []).map((r) => {
    const goLive = (r.toast_sales_start_date as string | null) ?? null;
    // Same rule as the labor feed (§1): the store's own go-live is the only
    // floor — a null go-live on an enabled store is a data error to fix in
    // locations, never a reason to guess a constant.
    if (!goLive) {
      throw new Error(
        `Toast kitchen: ${String(r.location_code)} is kitchen-enabled but has no toast_sales_start_date — set the store's go-live before ingesting`
      );
    }
    return {
      id: r.id as string,
      name: r.name as string,
      location_code: r.location_code as string,
      timezone: (r.timezone as string | null) ?? null,
      toast_restaurant_guid: (r.toast_restaurant_guid as string | null) ?? null,
      kitchen_start_date: goLive,
    };
  });
}

/** YYYY-MM-DD -> YYYYMMDD (Toast's businessDate shape). */
function toBusinessDate(isoDate: string): string {
  return isoDate.replaceAll("-", "");
}

/** Step an ISO date by n days (UTC-noon trick avoids DST edges). */
function addDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Inclusive ISO-date range [from, to], oldest first. */
function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The local dates one store's pull covers. Default (cron) is the rolling
 * 3-day window ending at the store's current local date, so late bumps and
 * edits land; an explicit from/to is the backfill path. Everything is clamped
 * to the store's go-live floor.
 */
function localDatesForPull(
  loc: KitchenLocation,
  tz: string,
  options: { from?: string; to?: string }
): string[] {
  const todayLocal = utcToLocalWallClock(new Date().toISOString(), tz)!.date;
  const to = options.to ?? todayLocal;
  const from = options.from ?? addDays(todayLocal, -2);
  const floored = from < loc.kitchen_start_date ? loc.kitchen_start_date : from;
  if (to < floored) return [];
  return dateRange(floored, to);
}

interface FulfillmentPayload {
  location_id: string;
  business_date: string;
  order_guid: string;
  ticket_guid: string;
  selection_guid: string;
  prep_station_guid: string;
  prep_station_name: string | null;
  item_fulfillment_level: number;
  menu_item_guid: string | null;
  menu_item_name: string | null;
  dining_option_behavior: string | null;
  course_name: string | null;
  order_source: string | null;
  ticket_fired_at: string | null;
  item_started_at: string | null;
  item_fulfilled_at: string | null;
  fired_local_date: string | null;
  fired_local_time: string | null;
  prep_seconds: number | null;
  raw: ItemFulfillment;
  updated_at: string;
}

export async function ingestToastKitchen(
  supabase: AdminClient,
  loc: KitchenLocation,
  localDates: string[]
): Promise<RunOutcome> {
  const base: RunOutcome = {
    source: "toast_kitchen",
    location_id: loc.id,
    location_code: loc.location_code,
    status: "running",
    rows_in: 0,
    rows_upserted: 0,
    rows_skipped: 0,
    detail: null,
    error_text: null,
    window_start: localDates.length ? `${localDates[0]}T00:00:00.000Z` : new Date().toISOString(),
    window_end: localDates.length
      ? `${localDates[localDates.length - 1]}T23:59:59.000Z`
      : new Date().toISOString(),
  };

  try {
    if (!loc.toast_restaurant_guid) {
      throw new Error(
        `${loc.location_code} is kitchen-enabled but has no toast_restaurant_guid (apply migration 042 after the flag-guard deploy).`
      );
    }
    const tz = storeTimezone(loc);

    let skippedMissingKeys = 0;
    let duplicatesCollapsed = 0;
    let negativeOrZeroPrep = 0;
    let overCapPrep = 0;
    let nullFired = 0;

    const byKey = new Map<string, FulfillmentPayload>();
    const nowIso = new Date().toISOString();

    for (const localDate of localDates) {
      const day = await fetchItemFulfillments(
        loc.toast_restaurant_guid,
        toBusinessDate(localDate)
      );
      if (day.status === 204) {
        // The RMS Pro+ gate — never an empty day. Surface loudly so the alert
        // fires; the fix is a Toast subscription conversation, not code.
        throw new Error(
          "Kitchen export returned 204 No Content — Toast RMS Pro+ subscription gate. Feed halted; talk to the Toast rep."
        );
      }
      if (day.status !== 200) {
        throw new Error(
          `Kitchen export HTTP ${day.status} for ${loc.location_code} ${localDate}: ${day.error_body ?? ""}`
        );
      }
      base.rows_in += day.rows.length;

      for (const r of day.rows) {
        if (!r.ticketGuid || !r.selectionGuid || !r.orderGuid) {
          skippedMissingKeys += 1;
          continue;
        }
        const firedLocal = utcToLocalWallClock(r.ticketFiredAt ?? null, tz);
        if (!firedLocal) nullFired += 1;

        let prepSeconds: number | null = null;
        const firedMs = r.ticketFiredAt ? Date.parse(r.ticketFiredAt) : NaN;
        const fulfilledMs = r.itemFulfilledAt ? Date.parse(r.itemFulfilledAt) : NaN;
        if (Number.isFinite(firedMs) && Number.isFinite(fulfilledMs)) {
          prepSeconds = Math.round((fulfilledMs - firedMs) / 1000);
          if (prepSeconds <= 0) negativeOrZeroPrep += 1;
          else if (prepSeconds > PREP_OUTLIER_SECONDS) overCapPrep += 1;
        }

        const payload: FulfillmentPayload = {
          location_id: loc.id,
          business_date: localDate,
          order_guid: r.orderGuid,
          ticket_guid: r.ticketGuid,
          selection_guid: r.selectionGuid,
          prep_station_guid: r.prepStationGuid ?? "",
          prep_station_name: r.prepStationName ?? null,
          item_fulfillment_level: Number(r.itemFulfillmentLevel ?? 0),
          menu_item_guid: r.selectionMenuItemGuid ?? null,
          menu_item_name: r.selectionMenuItemName ?? null,
          dining_option_behavior: r.diningOptionBehavior ?? null,
          course_name: r.courseName ?? null,
          order_source: r.orderSource ?? null,
          ticket_fired_at: r.ticketFiredAt ?? null,
          item_started_at: r.itemStartedAt ?? null,
          item_fulfilled_at: r.itemFulfilledAt ?? null,
          fired_local_date: firedLocal?.date ?? null,
          fired_local_time: firedLocal?.time ?? null,
          prep_seconds: prepSeconds,
          raw: r,
          updated_at: nowIso,
        };

        // Dedupe on the natural key, keeping the latest fulfilledAt — Toast
        // emits occasional exact duplicates, and a key colliding twice in one
        // upsert batch is a Postgres error, not a merge.
        const key = [
          payload.ticket_guid,
          payload.selection_guid,
          payload.prep_station_guid,
          payload.item_fulfillment_level,
        ].join("|");
        const existing = byKey.get(key);
        if (existing) {
          duplicatesCollapsed += 1;
          const a = existing.item_fulfilled_at ?? "";
          const b = payload.item_fulfilled_at ?? "";
          if (b >= a) byKey.set(key, payload);
        } else {
          byKey.set(key, payload);
        }
      }
    }

    const payloads = Array.from(byKey.values());
    let upserted = 0;
    const UPSERT_BATCH = 500;
    for (let i = 0; i < payloads.length; i += UPSERT_BATCH) {
      const batch = payloads.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase.from("toast_item_fulfillments").upsert(batch, {
        onConflict:
          "location_id,ticket_guid,selection_guid,prep_station_guid,item_fulfillment_level",
      });
      if (error) throw new Error(`toast_item_fulfillments upsert: ${error.message}`);
      upserted += batch.length;
    }

    // Recompute kitchen-role employees who worked the affected local dates.
    // Empty kitchen_role_config -> no jobs (attribution intentionally off
    // until the role seed migration lands).
    const affectedDates = Array.from(
      new Set(payloads.map((p) => p.fired_local_date ?? p.business_date))
    );
    const { data: roleRows, error: roleErr } = await supabase
      .from("kitchen_role_config")
      .select("role_name")
      .eq("is_kitchen", true);
    if (roleErr) throw new Error(`kitchen_role_config read: ${roleErr.message}`);
    const kitchenRoles = (roleRows ?? []).map((r) => r.role_name as string);

    let jobs: RecomputeJob[] = [];
    if (kitchenRoles.length > 0 && affectedDates.length > 0) {
      const { data: teRows, error: teErr } = await supabase
        .from("time_entries")
        .select("employee_id, entry_date")
        .eq("location_id", loc.id)
        .eq("entry_type", "worked")
        .in("entry_date", affectedDates)
        .in("role", kitchenRoles);
      if (teErr) throw new Error(`time_entries lookup: ${teErr.message}`);
      const seen = new Set<string>();
      jobs = [];
      for (const row of teRows ?? []) {
        const q = quarterForDate(row.entry_date as string);
        const key = `${row.employee_id}|${q.year}|${q.quarter}`;
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push({ employee_id: row.employee_id as string, year: q.year, quarter: q.quarter });
      }
    }
    const rc = await runRecomputeJobs(supabase, loc.id, jobs);

    base.rows_upserted = upserted;
    base.rows_skipped = skippedMissingKeys + duplicatesCollapsed;
    base.detail = {
      business_dates_pulled: localDates.length,
      rows_fetched: base.rows_in,
      rows_upserted: upserted,
      duplicates_collapsed: duplicatesCollapsed,
      skipped_missing_keys: skippedMissingKeys,
      null_ticket_fired_at: nullFired,
      negative_or_zero_prep: negativeOrZeroPrep,
      over_cap_prep: overCapPrep,
      kitchen_roles_configured: kitchenRoles.length,
      recompute_jobs: jobs.length,
      records_recomputed: rc.recomputed,
      recompute_failures: rc.failures.slice(0, 20),
    };
    base.status = upserted > 0 ? "success" : "empty";
    if (rc.failures.length > 0) {
      base.error_text = `${rc.failures.length} recompute failure(s); see detail`;
    }
    return base;
  } catch (err) {
    base.status = "error";
    base.error_text = err instanceof Error ? err.message : String(err);
    return base;
  }
}

export interface KitchenIngestSummary {
  started_at: string;
  finished_at: string;
  locations: number;
  runs: number;
  by_status: Record<string, number>;
  skipped_no_guid: string[];
  alert: { sent: boolean; reason: string };
  outcomes: Array<{
    location_code: string;
    status: string;
    rows_in: number;
    rows_upserted: number;
    rows_skipped: number;
    error_text: string | null;
  }>;
}

export interface KitchenIngestOptions {
  /** Restrict to one store (location_code); default all kitchen-enabled. */
  locationCode?: string;
  /** Backfill window (YYYY-MM-DD, inclusive); default rolling 3 local days. */
  from?: string;
  to?: string;
}

export async function runToastKitchenIngest(
  options: KitchenIngestOptions = {}
): Promise<KitchenIngestSummary> {
  const startedAt = new Date().toISOString();
  const supabase = createAdminClient();

  let crosswalk = await loadKitchenCrosswalk(supabase);
  if (options.locationCode) {
    crosswalk = crosswalk.filter((l) => l.location_code === options.locationCode);
    if (crosswalk.length === 0) {
      throw new Error(
        `No kitchen-enabled location with code "${options.locationCode}".`
      );
    }
  }

  // A kitchen-enabled store without a GUID (HOU until 042) is reported, not
  // silently dropped — but it can't produce an ingest run.
  const skippedNoGuid = crosswalk
    .filter((l) => !l.toast_restaurant_guid)
    .map((l) => l.location_code);
  const runnable = crosswalk.filter((l) => l.toast_restaurant_guid);

  const outcomes: RunOutcome[] = [];
  for (const loc of runnable) {
    // Window derivation can now throw (a store with no locations.timezone
    // refuses to guess). That failure must land as THIS store's error row
    // in ingest_runs — never a loop-killing fatal that leaves no per-store
    // evidence (Codex should-fix, LOCATION_CODES packet).
    let dates: string[];
    let windowStart = startedAt;
    let windowEnd = startedAt;
    try {
      const tz = storeTimezone(loc);
      dates = localDatesForPull(loc, tz, { from: options.from, to: options.to });
      if (dates.length) {
        windowStart = `${dates[0]}T00:00:00.000Z`;
        windowEnd = `${dates[dates.length - 1]}T23:59:59.000Z`;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const runId = await startRun(supabase, "toast_kitchen", loc.id, startedAt, startedAt);
      const outcome: RunOutcome = {
        source: "toast_kitchen",
        location_id: loc.id,
        location_code: loc.location_code,
        status: "error",
        rows_in: 0,
        rows_upserted: 0,
        rows_skipped: 0,
        detail: null,
        error_text: message,
        window_start: startedAt,
        window_end: startedAt,
      };
      await finishRun(supabase, runId, outcome);
      outcomes.push(outcome);
      continue;
    }
    const runId = await startRun(
      supabase,
      "toast_kitchen",
      loc.id,
      windowStart,
      windowEnd
    );
    const outcome = await ingestToastKitchen(supabase, loc, dates);
    await finishRun(supabase, runId, outcome);
    outcomes.push(outcome);
  }

  const streakReasons = await emptyStreakReasons(supabase, outcomes);
  const alert = await maybeSendFailureAlert(outcomes, streakReasons);

  const byStatus: Record<string, number> = {};
  for (const o of outcomes) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

  return {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    locations: crosswalk.length,
    runs: outcomes.length,
    by_status: byStatus,
    skipped_no_guid: skippedNoGuid,
    alert,
    outcomes: outcomes.map((o) => ({
      location_code: o.location_code,
      status: o.status,
      rows_in: o.rows_in,
      rows_upserted: o.rows_upserted,
      rows_skipped: o.rows_skipped,
      error_text: o.error_text,
    })),
  };
}
