/**
 * 7shifts scheduled shifts -> EPD `seven_shifts_shifts` (mig 054).
 *
 * EPD's OWN schedule feed (2026-08-23 sprint §4-H, Tucker's ruling): the
 * attendance denominator's raw input, pulled directly instead of second-hand
 * through CP. Runs IN PARALLEL with the CP-sourced `cp_schedule` feed for
 * cross-verification (§4-H5) and NEVER writes time_entries — that table is
 * UNIQUE (employee_id, entry_date, entry_type) with four existing writers,
 * and a fifth would collide with CP's schedule ingest nightly (§4-H3, pinned
 * by test). The attendance metric does NOT read this table yet (§4-H6).
 *
 * What the probe established (2026-08-23, all 3 companies) and this module
 * relies on:
 *  - `deleted`/`draft` are real payload fields but read false on every
 *    returned row — DELETED SHIFTS VANISH from the payload. The delete
 *    signal is therefore ABSENCE: after a complete window pull, stored rows
 *    the payload no longer contains get `missing_upstream_since` stamped
 *    (and cleared again if the shift reappears).
 *  - `attendance_status` (none|late|no_show) + `late_minutes` are 7shifts'
 *    own per-shift attendance call — stored verbatim.
 *  - Company 185592's payload includes a location EPD doesn't operate
 *    (521585, the Chico store on the shared CO token) — rows are filtered
 *    to crosswalked seven_shifts_location_ids.
 *  - `start[gte]`/`start[lte]` date filters are respected; a 35-day 8-store
 *    window is ~1.9k rows / ~10s across the three companies.
 *
 * ⚠️ THE MOST DANGEROUS PATH: absence-tombstoning after an incomplete pull
 * would read API flakiness as mass cancellation. Guards, in order: getAll
 * throws on any page error (the company's whole run errors, nothing is
 * tombstoned); a pull that fills the page cap is treated as truncated and
 * skips tombstoning; the tombstone update is scoped to the pulled window
 * and only ever sets a NULL missing_upstream_since. Tombstones are stamps,
 * not deletes — history is never erased.
 *
 * Open/unassigned shifts (open=true or user_id 0/null) are skipped at read
 * time (addendum §4): an open shift must never become anyone's missed
 * shift. Employees resolve by (seven_shifts_user_id, location_id), never by
 * name; a real user id with no roster row at that site is stored with
 * employee_id NULL and surfaced in run detail.
 */

import { getAllWithMeta } from "./client";
import { rolesForCompany } from "./roles";
import { employeeMapForLocation } from "./time";
import { classifyShifts, missingIds, type RawShift } from "./shifts-core";
import type { AdminClient, LocationCrosswalk } from "./crosswalk";
import {
  startRun,
  finishRun,
  lastSuccessfulWindowEnd,
  type RunOutcome,
} from "./runs";

export { classifyShifts, missingIds } from "./shifts-core";
export type { RawShift, ShiftUpsertRow, ShiftClassification } from "./shifts-core";

export const SHIFTS_SOURCE = "7shifts_shifts" as const;

/** Rolling window — mirrors the cp_schedule feed so the two stay comparable. */
const LOOKBACK_DAYS = 14;
const LOOKAHEAD_DAYS = 21;
/** First-run backfill floor — the cp_schedule floor, for a like-for-like
 * reconciliation baseline. Deeper history IS servable by 7shifts (probe Q2)
 * but a historical rebuild is a separate Tucker decision (§4-C4 flag).
 *
 * ⚠️ LOAD-BEARING BY COINCIDENCE (2026-08-25): this floor is also what
 * keeps the FROZEN QUARTERS (Q3/Q4 2025) safe from the flip — the pruned
 * denominator applies only where the direct feed has coverage, and
 * coverage starts here. That protection was chosen for a reconciliation
 * baseline, not as a policy boundary. If the §4-C4 historical rebuild ever
 * moves this floor earlier, the frozen-quarter guarantee moves with it —
 * that decision must involve THQ, not just this constant. */
export const SHIFTS_BACKFILL_FLOOR = "2026-06-01";

const LIST_LIMIT = 100;
const MAX_PAGES = 100;

/** Read every non-tombstoned stored shift id for a location + date window,
 * paged past PostgREST's 1000-row cap. */
async function storedLiveShiftIds(
  supabase: AdminClient,
  locationId: string,
  sinceDate: string,
  untilDate: string
): Promise<number[]> {
  const out: number[] = [];
  const BATCH = 1000;
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await supabase
      .from("seven_shifts_shifts")
      .select("seven_shifts_shift_id")
      .eq("location_id", locationId)
      .gte("entry_date", sinceDate)
      .lte("entry_date", untilDate)
      .is("missing_upstream_since", null)
      .order("seven_shifts_shift_id", { ascending: true })
      .range(from, from + BATCH - 1);
    if (error) throw new Error(`stored shift ids: ${error.message}`);
    for (const r of data ?? []) out.push(Number(r.seven_shifts_shift_id));
    if (!data || data.length < BATCH) break;
  }
  return out;
}

/** Stamp missing_upstream_since on rows a COMPLETE pull no longer returned.
 * Only ever sets a NULL stamp — never overwrites an earlier one. */
async function tombstoneMissing(
  supabase: AdminClient,
  locationId: string,
  sinceDate: string,
  untilDate: string,
  seenIds: Set<number>,
  nowIso: string
): Promise<number> {
  const stored = await storedLiveShiftIds(supabase, locationId, sinceDate, untilDate);
  const missing = missingIds(stored, seenIds);
  const CHUNK = 200;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    const { error } = await supabase
      .from("seven_shifts_shifts")
      .update({ missing_upstream_since: nowIso })
      .eq("location_id", locationId)
      .is("missing_upstream_since", null)
      .in("seven_shifts_shift_id", chunk);
    if (error) throw new Error(`tombstone update: ${error.message}`);
  }
  return missing.length;
}

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Pull + upsert + reconcile for every crosswalked location, one API pull per
 * company. Owns its ingest_runs rows (one per location, source
 * '7shifts_shifts') so the nightly orchestrator just spreads the outcomes.
 */
export async function ingestSevenShiftsShifts(
  supabase: AdminClient,
  crosswalk: LocationCrosswalk[]
): Promise<RunOutcome[]> {
  const nowIso = new Date().toISOString();
  const untilDate = isoDateOffset(LOOKAHEAD_DAYS);
  const outcomes: RunOutcome[] = [];

  const byCompany = new Map<number, LocationCrosswalk[]>();
  for (const loc of crosswalk) {
    const list = byCompany.get(loc.company_id) ?? [];
    list.push(loc);
    byCompany.set(loc.company_id, list);
  }

  for (const [companyId, companyLocations] of byCompany) {
    // First run for ANY of the company's stores widens to the backfill
    // floor (the whole company rides one pull).
    let sinceDate = isoDateOffset(-LOOKBACK_DAYS);
    for (const loc of companyLocations) {
      const prior = await lastSuccessfulWindowEnd(supabase, SHIFTS_SOURCE, loc.id);
      if (!prior) {
        sinceDate = SHIFTS_BACKFILL_FLOOR;
        break;
      }
    }
    const windowStart = `${sinceDate}T00:00:00.000Z`;
    const windowEnd = `${untilDate}T23:59:59.999Z`;

    const runIds = new Map<string, string | null>();
    const bases = new Map<string, RunOutcome>();
    for (const loc of companyLocations) {
      runIds.set(
        loc.id,
        await startRun(supabase, SHIFTS_SOURCE, loc.id, windowStart, windowEnd)
      );
      bases.set(loc.id, {
        source: SHIFTS_SOURCE,
        location_id: loc.id,
        location_code: loc.location_code,
        status: "running",
        rows_in: 0,
        rows_upserted: 0,
        rows_skipped: 0,
        detail: null,
        error_text: null,
        window_start: windowStart,
        window_end: windowEnd,
      });
    }

    try {
      let roleNames: Map<number, string> | null = null;
      let rolesLookupError: string | null = null;
      try {
        roleNames = await rolesForCompany(companyId);
      } catch (err) {
        rolesLookupError = err instanceof Error ? err.message : String(err);
      }

      // truncated comes from the client's cursor state, never a row count —
      // a page can return fewer than `limit` rows, so counting cannot
      // detect an unconsumed cursor (Codex finding 1). Upserts are still
      // safe on a truncated pull; absence-tombstoning is NOT (missing ≠
      // deleted) and is gated below.
      const { data: shifts, truncated } = await getAllWithMeta<RawShift>(
        companyId,
        "shifts",
        { "start[gte]": sinceDate, "start[lte]": untilDate, limit: LIST_LIMIT },
        MAX_PAGES
      );

      const userToEmployeeByLocation = new Map<string, Map<number, string>>();
      for (const loc of companyLocations) {
        userToEmployeeByLocation.set(
          loc.id,
          await employeeMapForLocation(supabase, loc.id)
        );
      }

      const classified = classifyShifts(
        shifts,
        companyLocations,
        userToEmployeeByLocation,
        nowIso,
        roleNames
      );

      const companyDetail = {
        company_id: companyId,
        company_rows_fetched: shifts.length,
        truncated_at_page_cap: truncated,
        skipped_open_or_unassigned: classified.skippedOpenOrUnassigned,
        skipped_draft: classified.skippedDraft,
        skipped_deleted: classified.skippedDeleted,
        skipped_other_location: classified.skippedOtherLocation,
        skipped_no_start: classified.skippedNoStart,
        ...(rolesLookupError ? { roles_lookup_error: rolesLookupError } : {}),
      };

      for (const loc of companyLocations) {
        const base = bases.get(loc.id)!;
        const rows = classified.byLocation.get(loc.id) ?? [];
        const seen = classified.seenIdsByLocation.get(loc.id) ?? new Set<number>();
        try {
          let upserted = 0;
          const UPSERT_BATCH = 500;
          for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
            const batch = rows.slice(i, i + UPSERT_BATCH);
            const { error } = await supabase
              .from("seven_shifts_shifts")
              .upsert(batch, { onConflict: "seven_shifts_shift_id" });
            if (error) throw new Error(`seven_shifts_shifts upsert: ${error.message}`);
            upserted += batch.length;
          }

          let tombstoned: number | null = null;
          if (!truncated) {
            tombstoned = await tombstoneMissing(
              supabase,
              loc.id,
              sinceDate,
              untilDate,
              seen,
              nowIso
            );
            // First-exercise observability (2026-08-25): tombstoning has
            // run in production exactly zero times before tonight, and the
            // pruned denominator the flip rests on depends on it. The
            // count was always recorded in detail; now it is LOUD — the
            // number a human sanity-checks against CP's independent ghost
            // count (26 measured, ~21 expected after CP's own prune). An
            // implausible share additionally reaches the ingest alert via
            // tombstoneAlertReasons below.
            const windowRows = rows.length;
            const share =
              windowRows + tombstoned > 0
                ? tombstoned / (windowRows + tombstoned)
                : 0;
            console.log(
              `[7shifts-shifts] ${loc.location_code} tombstoned ${tombstoned} row(s)`,
              JSON.stringify({
                window: { since: sinceDate, until: untilDate },
                rows_in_window: windowRows,
                tombstoned,
                share_pct: Math.round(share * 1000) / 10,
              })
            );
          }

          const locUnmatched = rows
            .filter((r) => r.employee_id === null)
            .map((r) => r.seven_shifts_user_id);
          base.rows_in = rows.length;
          base.rows_upserted = upserted;
          base.rows_skipped = locUnmatched.length;
          base.detail = {
            entries_upserted: upserted,
            unmatched_seven_shifts_user_ids: [...new Set(locUnmatched)].slice(0, 20),
            tombstoned_missing_upstream: tombstoned,
            tombstone_skipped_truncated_pull: truncated,
            ...companyDetail,
          };
          base.status = upserted > 0 ? "success" : "empty";
          if (rolesLookupError) {
            base.error_text = "roles lookup failed — role column left untouched this run";
          }
        } catch (err) {
          base.status = "error";
          base.error_text = err instanceof Error ? err.message : String(err);
        }
        await finishRun(supabase, runIds.get(loc.id) ?? null, base);
        outcomes.push(base);
      }
    } catch (err) {
      // Company-level failure (token, network, pagination error mid-pull):
      // every location's run errors; nothing was tombstoned.
      const message = err instanceof Error ? err.message : String(err);
      for (const loc of companyLocations) {
        const base = bases.get(loc.id)!;
        base.status = "error";
        base.error_text = `company ${companyId} pull failed: ${message}`;
        await finishRun(supabase, runIds.get(loc.id) ?? null, base);
        outcomes.push(base);
      }
    }
  }

  return outcomes;
}

/** Alert thresholds for an implausible tombstone share: at least this many
 * rows AND this share of the store's window. 13 real ghosts at DTD against
 * a ~35-day window is ~2% — logs, no alert; a flaky pull erasing a fifth
 * of a store's schedule is the "API flakiness read as mass cancellation"
 * path the module header names as the most dangerous. */
const TOMBSTONE_ALERT_MIN_ROWS = 10;
const TOMBSTONE_ALERT_SHARE = 0.2;

/**
 * Reasons for the shared ingest alert (2026-08-25): a run that tombstoned
 * an implausible share of a store's window must reach a human, not just a
 * log line. Derived from the outcomes' recorded detail so the orchestrator
 * wiring stays explicit and signature-free.
 */
export function tombstoneAlertReasons(outcomes: RunOutcome[]): string[] {
  const reasons: string[] = [];
  for (const o of outcomes) {
    if (o.source !== SHIFTS_SOURCE) continue;
    const detail = o.detail as Record<string, unknown> | null;
    const tombstoned = detail?.["tombstoned_missing_upstream"];
    if (typeof tombstoned !== "number") continue;
    const windowRows = o.rows_in;
    const share =
      windowRows + tombstoned > 0 ? tombstoned / (windowRows + tombstoned) : 0;
    if (tombstoned >= TOMBSTONE_ALERT_MIN_ROWS && share > TOMBSTONE_ALERT_SHARE) {
      reasons.push(
        `7shifts_shifts tombstoned an implausible share at ${o.location_code}: ${tombstoned} row(s), ${Math.round(share * 100)}% of the window — verify against 7shifts/CP before trusting the prune (the "API flakiness read as mass cancellation" path)`
      );
    }
  }
  return reasons;
}
