import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { timezoneForLocationCode } from "@/lib/ingest/sevenshifts/tz";
import {
  addDaysIso,
  buildCoverageEntry,
  punchDayDates,
  punchSourceForActuals,
  type CoverageEntry,
} from "@/lib/punch-days";

/**
 * EPD -> CulturePulse PUNCH-DAY feed — GET /api/identity/punch-days
 * (frozen-quarter spec addendum 2026-08-25 §4b).
 *
 * WHY: CP's schedule prune deletes rows 7shifts no longer returns, and the
 * Kevin Montie fence — NEVER prune a ghost with a matching punch — needs
 * punch visibility CP does not have. This feed answers "which dates does
 * each employee have a punch on", bounded by an explicit coverage marker so
 * "no punch" and "haven't looked yet" can never render identically.
 *
 * THE MARKER (see punch-days.ts for the measured failure modes of the two
 * obvious implementations):
 *   coverage_through = LEAST(local_date(last successful run's window_end),
 *                            local_date(its finished_at) - 1 day)
 * per location, against the location's OWN punch source (actuals_source:
 * toast -> toast_labor, cake -> cake_timesheets [NOLA], 7shifts ->
 * 7shifts_time) and its OWN clock (locations.timezone, mig 058). Only
 * status='success' runs advance it. EVERY location in scope gets a coverage
 * row — no source resolves to an explicit no_punch_source state, never an
 * omission. Dates past coverage_through land in the entry's not_answerable
 * range and NEVER contribute punch_days: a punch on an unanswerable date is
 * withheld rather than asserted, so the answer set and the coverage claim
 * can't disagree.
 *
 * Punch source of record: v_worked_intervals (mig 058) — the flip's single
 * worked-time view (Toast punches post-go-live, time_entries before and at
 * NOLA), store-local dates by construction. A shift whose local end date
 * exceeds its start date marks BOTH dates (after-midnight landings).
 *
 * Auth + envelope: `Authorization: Bearer <SCORES_FEED_TOKEN>` and the
 * identity feed's `{ data, pagination: { limit, offset, count, has_more } }`
 * envelope; rides proxy.ts's existing /api/identity prefix carve-out
 * (startsWith — no proxy diff, the /api/scores/range pattern).
 */

export const dynamic = "force-dynamic";
// Estate-wide quarter windows page through v_worked_intervals; same ceiling
// as the other feed routes.
export const maxDuration = 300;

const MAX_LIMIT = 1000;
const PAGE = 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Range cap, matching the range feed's window bound. */
const MAX_RANGE_DAYS = 366;

interface LocationRow {
  id: string;
  location_code: string;
  actuals_source: string | null;
  timezone: string | null;
}

export async function GET(request: Request) {
  const denied = requireBearer(
    request,
    process.env.SCORES_FEED_TOKEN,
    "SCORES_FEED_TOKEN"
  );
  if (denied) return denied;

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const locationParam = url.searchParams.get("location_code");
  const employeeCode = url.searchParams.get("employee_code");

  if (!from || !to || !ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    return NextResponse.json(
      { error: "from and to are required as YYYY-MM-DD" },
      { status: 400 }
    );
  }
  if (from > to) {
    return NextResponse.json(
      { error: `from (${from}) must not be after to (${to})` },
      { status: 400 }
    );
  }
  {
    const spanMs = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
    if (spanMs / 86400000 + 1 > MAX_RANGE_DAYS) {
      return NextResponse.json(
        { error: `window exceeds ${MAX_RANGE_DAYS} days` },
        { status: 400 }
      );
    }
  }

  const rawLimit = Number(url.searchParams.get("limit") ?? MAX_LIMIT);
  const limit = Number.isNaN(rawLimit)
    ? MAX_LIMIT
    : Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT);
  const rawOffset = Number(url.searchParams.get("offset") ?? 0);
  const offset = Number.isNaN(rawOffset) ? 0 : Math.max(Math.trunc(rawOffset), 0);

  const supabase = createAdminClient();

  try {
    // Locations from the DATABASE — the per-store table's row count is the
    // number of locations, read, never hardcoded (§4b pin: "seven stores"
    // has been wrong about the eighth three times today).
    const { data: locRows, error: locError } = await supabase
      .from("locations")
      .select("id, location_code, actuals_source, timezone")
      .order("location_code", { ascending: true });
    if (locError) throw new Error(`locations read: ${locError.message}`);
    const allLocations = (locRows ?? []) as LocationRow[];

    let scope = allLocations;
    if (locationParam) {
      const requested = locationParam.split(",").map((s) => s.trim()).filter(Boolean);
      const known = new Map(allLocations.map((l) => [l.location_code, l]));
      const unknown = requested.filter((c) => !known.has(c));
      if (unknown.length > 0) {
        return NextResponse.json(
          { error: `Unknown location_code(s): ${unknown.join(", ")}` },
          { status: 400 }
        );
      }
      scope = requested.map((c) => known.get(c)!);
    }

    // Optional employee filter — unknown code is a 400, not an empty answer
    // (an empty answer to a typo would read as "no punches anywhere").
    let employeeFilterId: string | null = null;
    if (employeeCode) {
      const { data: emp, error: empErr } = await supabase
        .from("employees")
        .select("id")
        .eq("employee_code", employeeCode)
        .maybeSingle();
      if (empErr) throw new Error(`employee lookup: ${empErr.message}`);
      if (!emp) {
        return NextResponse.json(
          { error: `Unknown employee_code "${employeeCode}"` },
          { status: 400 }
        );
      }
      employeeFilterId = String(emp.id);
    }

    // Coverage row for EVERY location in scope. Only status='success' runs
    // advance the mark — a failed nightly leaves it where it was.
    const coverage: CoverageEntry[] = [];
    const answerableThroughByLocation = new Map<string, string | null>();
    for (const loc of scope) {
      const source = punchSourceForActuals(loc.actuals_source);
      let lastSuccess: { window_end: string | null; finished_at: string } | null =
        null;
      if (source) {
        const { data: run, error: runErr } = await supabase
          .from("ingest_runs")
          .select("window_end, finished_at")
          .eq("location_id", loc.id)
          .eq("source", source)
          .eq("status", "success")
          .not("finished_at", "is", null)
          .order("finished_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (runErr) throw new Error(`ingest_runs read (${loc.location_code}): ${runErr.message}`);
        if (run?.finished_at) {
          lastSuccess = {
            window_end: (run.window_end as string | null) ?? null,
            finished_at: run.finished_at as string,
          };
        }
      }
      const tz = loc.timezone ?? timezoneForLocationCode(loc.location_code);
      const entry = buildCoverageEntry(
        loc.location_code,
        loc.actuals_source,
        lastSuccess,
        tz,
        from,
        to
      );
      coverage.push(entry);
      answerableThroughByLocation.set(loc.id, entry.answerable?.to ?? null);
    }

    // Punch rows from the flip's single worked-time source. entry_date is
    // fetched from one day BEFORE the range so a shift starting on from-1
    // and ending after midnight can mark `from`.
    const fetchFrom = addDaysIso(from, -1);
    const scopeIds = scope.map((l) => l.id);
    const codeByLocationId = new Map(scope.map((l) => [l.id, l.location_code]));
    type IntervalRow = {
      location_id: string;
      employee_id: string;
      shift_start: string;
      shift_end: string | null;
    };
    const punchDaysByEmployee = new Map<string, Map<string, Set<string>>>();
    for (let page = 0; ; page += PAGE) {
      const { data, error } = await supabase
        .from("v_worked_intervals")
        .select("location_id, employee_id, shift_start, shift_end")
        .in("location_id", scopeIds)
        .gte("entry_date", fetchFrom)
        .lte("entry_date", to)
        .order("employee_id", { ascending: true })
        .order("entry_date", { ascending: true })
        .range(page, page + PAGE - 1);
      if (error) throw new Error(`v_worked_intervals read: ${error.message}`);
      for (const row of (data ?? []) as IntervalRow[]) {
        if (employeeFilterId && String(row.employee_id) !== employeeFilterId) continue;
        const answerableThrough = answerableThroughByLocation.get(String(row.location_id));
        if (!answerableThrough) continue; // nothing answerable at this location
        for (const day of punchDayDates(row.shift_start, row.shift_end)) {
          // Only answerable dates are asserted — a punch on a date past
          // coverage_through is withheld, so the punch set can never
          // contradict the coverage claim.
          if (day < from || day > answerableThrough) continue;
          let byLoc = punchDaysByEmployee.get(String(row.employee_id));
          if (!byLoc) {
            byLoc = new Map();
            punchDaysByEmployee.set(String(row.employee_id), byLoc);
          }
          const locCode = codeByLocationId.get(String(row.location_id)) ?? "?";
          let days = byLoc.get(locCode);
          if (!days) {
            days = new Set();
            byLoc.set(locCode, days);
          }
          days.add(day);
        }
      }
      if (!data || data.length < PAGE) break;
    }

    // Identity for the employees that surfaced, chunked.
    type EmpRow = {
      id: string;
      employee_code: string;
      employee_name: string;
      seven_shifts_user_id: number | null;
    };
    const empById = new Map<string, EmpRow>();
    {
      const ids = [...punchDaysByEmployee.keys()];
      for (let i = 0; i < ids.length; i += 150) {
        const { data, error } = await supabase
          .from("employees")
          .select("id, employee_code, employee_name, seven_shifts_user_id")
          .in("id", ids.slice(i, i + 150));
        if (error) throw new Error(`employees read: ${error.message}`);
        for (const e of (data ?? []) as EmpRow[]) empById.set(String(e.id), e);
      }
    }

    interface DataRow {
      employee_code: string;
      employee_name: string;
      seven_shifts_user_id: number | null;
      location_code: string;
      punch_days: string[];
    }
    const rows: DataRow[] = [];
    for (const [employeeId, byLoc] of punchDaysByEmployee) {
      const emp = empById.get(employeeId);
      for (const [locCode, days] of byLoc) {
        rows.push({
          employee_code: emp?.employee_code ?? "?",
          employee_name: emp?.employee_name ?? "?",
          seven_shifts_user_id: emp?.seven_shifts_user_id ?? null,
          location_code: locCode,
          punch_days: [...days].sort(),
        });
      }
    }
    // Total order (the #36 lesson): employee_code alone is not provably
    // unique across a multi-location row split — the pair is.
    rows.sort(
      (a, b) =>
        a.employee_code.localeCompare(b.employee_code) ||
        a.location_code.localeCompare(b.location_code)
    );

    const pageRows = rows.slice(offset, offset + limit);
    return NextResponse.json({
      range: { from, to },
      coverage,
      data: pageRows,
      pagination: {
        limit,
        offset,
        count: rows.length,
        has_more: offset + pageRows.length < rows.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[punch-days-feed] fatal:", message);
    return NextResponse.json(
      { error: "Internal error retrieving punch days" },
      { status: 500 }
    );
  }
}
