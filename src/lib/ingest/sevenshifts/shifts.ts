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
 * but a historical rebuild is a separate Tucker decision (§4-C4 flag). */
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
  crosswalk: LocationCrosswalk[],
  opts?: {
    /**
     * Explicit entry-date window (YYYY-MM-DD, inclusive) — the §3f
     * historical extension (Q2 punch-recovery spec 2026-08-25). Overrides
     * BOTH the rolling window and the first-run floor. The floor
     * (SHIFTS_BACKFILL_FLOOR, 2026-06-01) exists because pre-June history
     * feeds the flip's day-conditional scheduled source — an explicit
     * window is a deliberate, operator-driven act via
     * /api/admin/backfill-shifts-window, never a nightly default.
     */
    window?: { since: string; until: string };
  }
): Promise<RunOutcome[]> {
  const nowIso = new Date().toISOString();
  const untilDateDefault = isoDateOffset(LOOKAHEAD_DAYS);
  const outcomes: RunOutcome[] = [];

  const byCompany = new Map<number, LocationCrosswalk[]>();
  for (const loc of crosswalk) {
    const list = byCompany.get(loc.company_id) ?? [];
    list.push(loc);
    byCompany.set(loc.company_id, list);
  }

  for (const [companyId, companyLocations] of byCompany) {
    // First run for ANY of the company's stores widens to the backfill
    // floor (the whole company rides one pull). An explicit window wins
    // over both.
    let sinceDate = isoDateOffset(-LOOKBACK_DAYS);
    let untilDate = untilDateDefault;
    if (opts?.window) {
      sinceDate = opts.window.since;
      untilDate = opts.window.until;
    } else {
      for (const loc of companyLocations) {
        // First-run detection ignores historical operator backfills: their
        // window_end predates the floor by construction, so requiring a
        // prior success AT the floor or later means only a real nightly /
        // floor run counts (Codex 2026-08-25 — else a fresh environment
        // whose only run is an April–May backfill would never widen to the
        // floor).
        const prior = await lastSuccessfulWindowEnd(supabase, SHIFTS_SOURCE, loc.id, {
          windowEndAtLeast: SHIFTS_BACKFILL_FLOOR,
        });
        if (!prior) {
          sinceDate = SHIFTS_BACKFILL_FLOOR;
          break;
        }
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

          // Tombstoning is DISABLED on an explicit historical window
          // (Codex 2026-08-25): over deep history, absence from the
          // payload may mean 7shifts' retention boundary, not deletion —
          // stamping missing_upstream_since on a re-run would read
          // retention as mass cancellation. The §3f backfill ingests
          // evidence; the nightly's rolling window keeps sole custody of
          // absence semantics.
          let tombstoned: number | null = null;
          if (!truncated && !opts?.window) {
            tombstoned = await tombstoneMissing(
              supabase,
              loc.id,
              sinceDate,
              untilDate,
              seen,
              nowIso
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
            tombstone_skipped_historical_window: Boolean(opts?.window),
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
