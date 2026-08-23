import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createCpClient } from "@/lib/ingest/culture-pulse/client";
import { loadCrosswalk } from "@/lib/ingest/sevenshifts/crosswalk";
import { CP_LOCATION_MAP } from "@/lib/ingest/culture-pulse/crosswalk";
import { getAll } from "@/lib/ingest/sevenshifts/client";

/**
 * STEP 0 probe for the direct 7shifts scheduled-shift feed
 * (kickoff-multilocation-users-metrics-CODE-2026-08-23 §4-H2 + the
 * 2026-08-23 addendum). READ-ONLY — no writes to either database. Follows
 * the probe-7shifts-hire-date pattern: CRON_SECRET-gated, run from the
 * deployed app (the three 7shifts tokens are Sensitive Vercel vars), key
 * lists and shapes only — no names, no emails, no token material.
 *
 * The addendum collapsed the original seven questions into two decisive
 * ones (CP confirmed the `deleted` and `draft` field names exist):
 *
 *  Q1. Does GET /v2/company/{id}/shifts still RETURN a deleted shift with
 *      deleted=true, or does it vanish from the payload? Measured by
 *      comparing the payload's shift-id set against CP's
 *      weekly_schedule_entries (the accumulated superset — CP never prunes)
 *      for the same window: ids CP holds that 7shifts no longer returns are
 *      the deleted population. That comparison is itself the measurement CP
 *      asked for, reported per store per week.
 *  Q2. Does the endpoint serve arbitrary HISTORICAL windows with final
 *      state? Measured by pulling a deep-history week and reporting what
 *      comes back vs EPD's stored scheduled rows for the same week.
 *
 * Plus: full payload key discovery (union + non-null counts + distinct
 * values for discriminator-shaped keys), open-shift / null-assignee counts,
 * location_id ↔ crosswalk match, pull cost for the cron budget, and the
 * single cheapest decisive test in the sprint — Nathan Johnson EMP-100214
 * (COS, 7s user 11787881): of his stored scheduled days, how many still
 * exist upstream, and in what state.
 *
 * AUTH: Bearer <CRON_SECRET>.
 *   GET /api/admin/probe-7shifts-shifts
 *     ?start=YYYY-MM-DD&end=YYYY-MM-DD          recent window (default last 35d)
 *     &hist_start=YYYY-MM-DD&hist_end=YYYY-MM-DD deep-history week (default
 *                                                2025-10-06..2025-10-12)
 *     &gte_key=start[gte]&lte_key=start[lte]     date-filter param names to
 *                                                try (the field list is not
 *                                                publicly documented — if the
 *                                                payload ignores them, min/max
 *                                                dates in the report say so)
 *     &test_employee_code=EMP-100214
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DISCRIMINATOR_RE = /delet|draft|open|publish|status|void|archiv|close/i;
const DISTINCT_CAP = 8;
const LIST_LIMIT = 100;
const MAX_PAGES = 40;

type ShiftRow = Record<string, unknown>;

/** Clamp echoed scalars — the no-PII invariant must not depend on 7shifts. */
function redactScalar(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "object") return `(${Array.isArray(v) ? "array" : "object"})`;
  return String(v).slice(0, 40);
}

/** YYYY-MM-DD from a shift timestamp. 7shifts returns local-time ISO with an
 * offset, so the first 10 chars ARE the store-local date; if the format
 * differs the raw prefix is still reported and the caveat noted in output. */
function datePart(v: unknown): string | null {
  if (typeof v !== "string" || v.length < 10) return null;
  const d = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/** UTC Monday of the week containing a YYYY-MM-DD date. */
function weekMonday(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

interface KeyStat {
  non_null: number;
  distinct_values?: Record<string, number>;
}

/** Union of payload keys with non-null counts; discriminator-shaped keys also
 * report their distinct (redacted) values with counts. */
function discoverKeys(rows: ShiftRow[]): Record<string, KeyStat> {
  const stats = new Map<string, KeyStat>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      let s = stats.get(k);
      if (!s) {
        s = { non_null: 0 };
        if (DISCRIMINATOR_RE.test(k)) s.distinct_values = {};
        stats.set(k, s);
      }
      if (v !== null && v !== undefined && v !== "") s.non_null += 1;
      if (s.distinct_values) {
        const val = redactScalar(v);
        if (
          s.distinct_values[val] !== undefined ||
          Object.keys(s.distinct_values).length < DISTINCT_CAP
        ) {
          s.distinct_values[val] = (s.distinct_values[val] ?? 0) + 1;
        }
      }
    }
  }
  return Object.fromEntries([...stats.entries()].sort());
}

/** CP weekly_schedule_entries for a window + CP-location set, paged past
 * PostgREST's 1000-row cap. Shift id + start only — no names. */
async function readCpWindow(
  cpLocationIds: string[],
  startIso: string,
  endIso: string
): Promise<Array<{ shiftId: string; cpLocationId: string; date: string }>> {
  const cp = createCpClient();
  const out: Array<{ shiftId: string; cpLocationId: string; date: string }> =
    [];
  const BATCH = 1000;
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await cp
      .from("weekly_schedule_entries")
      .select("sevenshifts_shift_id, location_id, shift_start_at")
      .in("location_id", cpLocationIds)
      .gte("shift_start_at", startIso)
      .lt("shift_start_at", endIso)
      .not("sevenshifts_shift_id", "is", null)
      .order("shift_start_at", { ascending: true })
      .range(from, from + BATCH - 1);
    if (error) throw new Error(`CP weekly_schedule_entries: ${error.message}`);
    for (const r of data ?? []) {
      const date = datePart(r.shift_start_at);
      if (r.sevenshifts_shift_id && date) {
        out.push({
          shiftId: String(r.sevenshifts_shift_id),
          cpLocationId: String(r.location_id),
          date,
        });
      }
    }
    if (!data || data.length < BATCH) break;
  }
  return out;
}

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const today = new Date().toISOString().slice(0, 10);
  const defaultStart = new Date(Date.now() - 35 * 86400_000)
    .toISOString()
    .slice(0, 10);
  const start = url.searchParams.get("start") ?? defaultStart;
  const end = url.searchParams.get("end") ?? today;
  const histStart = url.searchParams.get("hist_start") ?? "2025-10-06";
  const histEnd = url.searchParams.get("hist_end") ?? "2025-10-12";
  const gteKey = url.searchParams.get("gte_key") ?? "start[gte]";
  const lteKey = url.searchParams.get("lte_key") ?? "start[lte]";
  const testEmployeeCode =
    url.searchParams.get("test_employee_code") ?? "EMP-100214";

  try {
    const supabase = createAdminClient();
    const crosswalk = await loadCrosswalk(supabase);
    const companyIds = [...new Set(crosswalk.map((l) => l.company_id))];

    // company -> its stores' CP location ids (7s crosswalk ⋈ CP crosswalk on
    // location_code) and 7shifts location ids, for the Q1 comparison and the
    // location-match check.
    const cpIdByCode = new Map(
      CP_LOCATION_MAP.map((m) => [m.location_code, m.cp_location_id])
    );
    const codeByCpId = new Map(
      CP_LOCATION_MAP.map((m) => [m.cp_location_id, m.location_code])
    );

    // The decisive-test employee (§4-C1 / addendum §5): stored schedule vs
    // upstream truth.
    const { data: testEmp, error: testEmpError } = await supabase
      .from("employees")
      .select("id, employee_code, location_id, seven_shifts_user_id")
      .eq("employee_code", testEmployeeCode)
      .maybeSingle();
    if (testEmpError) throw new Error(`test employee: ${testEmpError.message}`);

    const companies = [];
    for (const companyId of companyIds) {
      const companyLocs = crosswalk.filter((l) => l.company_id === companyId);
      const companyCodes = companyLocs.map((l) => l.location_code);
      const sevenShiftsLocIds = new Set(
        companyLocs.map((l) => l.seven_shifts_location_id)
      );
      const cpLocationIds = companyCodes
        .map((c) => cpIdByCode.get(c))
        .filter((v): v is string => Boolean(v));

      try {
        // ── Recent window pull (cost measurement rides this) ────────────────
        const t0 = Date.now();
        const shifts = await getAll<ShiftRow>(
          companyId,
          "shifts",
          { [gteKey]: start, [lteKey]: end, limit: LIST_LIMIT },
          MAX_PAGES
        );
        const elapsedMs = Date.now() - t0;

        const keys = discoverKeys(shifts);
        const dates = shifts
          .map((s) => datePart(s["start"]))
          .filter((d): d is string => d !== null);
        const minDate = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null;
        const maxDate = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;

        const deletedTrue = shifts.filter((s) => s["deleted"] === true).length;
        const draftTrue = shifts.filter((s) => s["draft"] === true).length;
        const openTrue = shifts.filter((s) => s["open"] === true).length;
        const nullAssignee = shifts.filter(
          (s) => !num(s["user_id"]) || s["user_id"] === 0
        ).length;

        // location_id ↔ crosswalk match
        const payloadLocCounts = new Map<number, number>();
        for (const s of shifts) {
          const lid = num(s["location_id"]);
          if (lid !== null)
            payloadLocCounts.set(lid, (payloadLocCounts.get(lid) ?? 0) + 1);
        }
        const locationMatch = [...payloadLocCounts.entries()].map(
          ([lid, count]) => ({
            payload_location_id: lid,
            rows: count,
            in_crosswalk: sevenShiftsLocIds.has(lid),
          })
        );

        // ── Q1: payload id-set vs CP's accumulated superset ────────────────
        const payloadIds = new Set(
          shifts.map((s) => num(s["id"])).filter((v): v is number => v !== null)
        );
        const activeIds = new Set(
          shifts
            .filter((s) => s["deleted"] !== true && s["draft"] !== true)
            .map((s) => num(s["id"]))
            .filter((v): v is number => v !== null)
        );
        const cpRows = await readCpWindow(
          cpLocationIds,
          `${start}T00:00:00Z`,
          `${end}T23:59:59Z`
        );
        let cpBoth = 0;
        let cpOnlyTotal = 0;
        let cpMatchedDeletedOrDraft = 0;
        // store -> week -> count of CP rows whose shift 7shifts no longer
        // returns (the addendum's headline number, per store per week).
        const cpOnlyByStoreWeek: Record<string, Record<string, number>> = {};
        for (const r of cpRows) {
          const idNum = Number(r.shiftId);
          if (payloadIds.has(idNum)) {
            cpBoth += 1;
            if (!activeIds.has(idNum)) cpMatchedDeletedOrDraft += 1;
            continue;
          }
          cpOnlyTotal += 1;
          const code = codeByCpId.get(r.cpLocationId) ?? "UNMAPPED";
          const week = weekMonday(r.date);
          cpOnlyByStoreWeek[code] = cpOnlyByStoreWeek[code] ?? {};
          cpOnlyByStoreWeek[code][week] =
            (cpOnlyByStoreWeek[code][week] ?? 0) + 1;
        }

        // ── Q2: deep-history pull ──────────────────────────────────────────
        const h0 = Date.now();
        const histShifts = await getAll<ShiftRow>(
          companyId,
          "shifts",
          { [gteKey]: histStart, [lteKey]: histEnd, limit: LIST_LIMIT },
          MAX_PAGES
        );
        const histElapsedMs = Date.now() - h0;
        const histDates = histShifts
          .map((s) => datePart(s["start"]))
          .filter((d): d is string => d !== null);

        // EPD's stored scheduled rows for the same historical week, for scale.
        const companyEpdLocIds = companyLocs.map((l) => l.id);
        const { count: epdHistCount, error: epdHistError } = await supabase
          .from("time_entries")
          .select("id, employees!inner(location_id)", {
            count: "exact",
            head: true,
          })
          .eq("entry_type", "scheduled")
          .gte("entry_date", histStart)
          .lte("entry_date", histEnd)
          .in("employees.location_id", companyEpdLocIds);
        if (epdHistError)
          throw new Error(`EPD historical count: ${epdHistError.message}`);

        // ── Decisive test: the probe employee's stored days vs upstream ────
        let decisiveTest: Record<string, unknown> | null = null;
        const testUserId = num(testEmp?.seven_shifts_user_id ?? null);
        if (
          testEmp &&
          testUserId !== null &&
          companyLocs.some((l) => l.id === testEmp.location_id)
        ) {
          const { data: storedEntries, error: storedError } = await supabase
            .from("time_entries")
            .select("entry_date, entry_type")
            .eq("employee_id", testEmp.id)
            .gte("entry_date", start)
            .lte("entry_date", end)
            .in("entry_type", ["scheduled", "worked"]);
          if (storedError)
            throw new Error(`stored entries: ${storedError.message}`);
          const storedScheduled = (storedEntries ?? [])
            .filter((e) => e.entry_type === "scheduled")
            .map((e) => String(e.entry_date).slice(0, 10))
            .sort();
          const storedWorked = new Set(
            (storedEntries ?? [])
              .filter((e) => e.entry_type === "worked")
              .map((e) => String(e.entry_date).slice(0, 10))
          );
          const upstreamByDate = new Map<
            string,
            { active: number; deleted: number; draft: number }
          >();
          for (const s of shifts) {
            if (num(s["user_id"]) !== testUserId) continue;
            const d = datePart(s["start"]);
            if (!d) continue;
            const slot = upstreamByDate.get(d) ?? {
              active: 0,
              deleted: 0,
              draft: 0,
            };
            if (s["deleted"] === true) slot.deleted += 1;
            else if (s["draft"] === true) slot.draft += 1;
            else slot.active += 1;
            upstreamByDate.set(d, slot);
          }
          const perDay = storedScheduled.map((d) => {
            const up = upstreamByDate.get(d);
            return {
              date: d,
              worked: storedWorked.has(d),
              upstream: up
                ? up.active > 0
                  ? "active"
                  : up.deleted > 0
                    ? "deleted"
                    : "draft"
                : "absent",
            };
          });
          decisiveTest = {
            employee_code: testEmp.employee_code,
            seven_shifts_user_id: testUserId,
            window: { start, end },
            stored_scheduled_days: storedScheduled.length,
            stored_days_detail: perDay,
            upstream_days_absent: perDay.filter((p) => p.upstream === "absent")
              .length,
            upstream_days_deleted: perDay.filter(
              (p) => p.upstream === "deleted"
            ).length,
            upstream_days_active: perDay.filter((p) => p.upstream === "active")
              .length,
            note: "dates are the local-date prefix of the shift start; late-night shifts near midnight could straddle a day",
          };
        }

        companies.push({
          company_id: companyId,
          location_codes: companyCodes,
          recent_window: {
            start,
            end,
            date_filter_params_tried: { [gteKey]: start, [lteKey]: end },
            rows: shifts.length,
            truncated_at_max_pages: shifts.length >= LIST_LIMIT * MAX_PAGES,
            elapsed_ms: elapsedMs,
            payload_min_start: minDate,
            payload_max_start: maxDate,
            window_respected:
              minDate !== null &&
              maxDate !== null &&
              minDate >= start &&
              maxDate <= end,
          },
          payload_keys: keys,
          discriminators: {
            deleted_true: deletedTrue,
            draft_true: draftTrue,
            open_true: openTrue,
            null_or_zero_assignee: nullAssignee,
          },
          location_match: locationMatch,
          q1_vs_cp_superset: {
            cp_rows_in_window_with_shift_id: cpRows.length,
            in_both: cpBoth,
            cp_matched_but_deleted_or_draft_upstream: cpMatchedDeletedOrDraft,
            cp_only_missing_upstream: cpOnlyTotal,
            cp_only_by_store_week: cpOnlyByStoreWeek,
          },
          q2_historical: {
            hist_start: histStart,
            hist_end: histEnd,
            rows: histShifts.length,
            elapsed_ms: histElapsedMs,
            payload_min_start: histDates.length
              ? histDates.reduce((a, b) => (a < b ? a : b))
              : null,
            payload_max_start: histDates.length
              ? histDates.reduce((a, b) => (a > b ? a : b))
              : null,
            deleted_true: histShifts.filter((s) => s["deleted"] === true)
              .length,
            draft_true: histShifts.filter((s) => s["draft"] === true).length,
            epd_stored_scheduled_same_week: epdHistCount ?? 0,
          },
          decisive_test: decisiveTest,
        });
      } catch (err) {
        companies.push({
          company_id: companyId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return NextResponse.json({
      probe: "7shifts-shifts",
      note: "READ-ONLY — no writes. H3/H4 are built only after this output is read (addendum 2026-08-23 §3).",
      companies,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[probe-7shifts-shifts] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
