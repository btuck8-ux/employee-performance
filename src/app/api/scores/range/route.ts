import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { LOCATION_CODES } from "@/lib/location-codes";
import {
  computeMetricsForRange,
} from "@/lib/performance-recompute";
import { fetchCustomerServiceWeights } from "@/lib/customer-service-score";
import { fetchTotalImpactWeights } from "@/lib/total-impact-score";
import {
  compareRangeFeedMembers,
  toRangeFeedRow,
  validateRangeParams,
  type RangeFeedRow,
} from "@/lib/range-feed";

/**
 * EPD date-range scores feed — GET /api/scores/range (consumer: Training HQ,
 * server-side pass-through with a 10-min cache TTL, never written to their
 * mirror).
 *
 * ⚠️ CP AND THQ DO NOT POLL THIS ROUTE — /api/scores IS THE CONSUMER WIRE
 * (2026-08-25, pinned). This route computes LIVE per request
 * (computeMetricsForRange); the wire is STORED (v_employee_scores →
 * performance_records). "The flip is live here" says nothing about what
 * consumers see — that mistake reached THQ once, disproved by their own
 * computed_at stamps 34 minutes after the deploy. If you are reasoning
 * about what a partner receives, you are in the wrong file: go one
 * directory up.
 *
 * Contract: memo-to-training-hq-range-contract-2026-08-14.md, accepted
 * VERBATIM by THQ 2026-08-14 and LOCKED — params (start/end calendar-valid,
 * start >= 2026-01-01, window <= 366 days; optional location_code CSV +
 * single employee_code; page/limit default 25 / max 50), response
 * `{ data, pagination: { page, limit, count }, range, computed_at }`, the
 * 18 wire fields (3 identity + 9 metrics + 6 counts, RANGE_FEED_FIELDS),
 * 400-with-reason on invalid params. Composites are deliberately absent in
 * v1 (THQ confirmed — "Quarterly only" tiles on their side). Shape changes
 * need the same cross-project coordination as /api/scores; /api/scores
 * itself and its 26-column contract are UNTOUCHED by this route.
 *
 * Compute: reuses computeMetricsForRange verbatim — the canonical range
 * engine behind custom-range PDFs and the Overview custom-range view (zero
 * new scoring math; TS<->SQL lockstep doctrine). On-demand, per-employee,
 * nothing persisted. Population rule (Tucker decision 2026-08-14):
 * employees — active or since-departed — with ANY relevant source rows in
 * the window (time entries, attributed tattles, attributed reviews, survey
 * assignments, task accountability). A valid window with no such employees
 * returns 200 with empty data.
 *
 * ── DATA FLOORS — "not computable for this window" per metric ─────────────
 * Null on the wire means the window genuinely can't produce the number —
 * never 0. THQ mirrors these conditions in their "Not computable for this
 * window" UI state:
 *   on_time_grace_pct             null when the employee ATTENDED zero
 *                                 scheduled shifts in the window (the
 *                                 denominator is attended shifts; a shift
 *                                 with a missing/malformed clock-in time is
 *                                 excluded from the punctuality numerator).
 *   attendance_pct                null when the window contains zero SCORED
 *                                 scheduled shifts — scheduled dates are
 *                                 scored only through min(today, the
 *                                 location's latest worked-entry date), so
 *                                 future-posted schedules never count as
 *                                 missed. Scheduled data exists Apr–May 2026
 *                                 (CSV era) and 2026-06-01→present (CP
 *                                 feed); windows outside that are honestly
 *                                 null.
 *   survey_engagement_pct         null when zero surveys were SENT to the
 *                                 employee in the window (surveys_assigned
 *                                 is the denominator).
 *   customer_service_rating       null when zero attributed customer
 *                                 reviews carry a rating in the window.
 *   tattle_rating                 null when zero attributed Tattle surveys
 *                                 carry an overall rating in the window.
 *   tattle_score_food_quality /   null when zero attributed Tattle surveys
 *   _accuracy / _speed_of_service carry that sub-score in the window (a
 *                                 survey can carry the rating but not every
 *                                 sub-score).
 *   avg_task_list_completion_pct  null when the employee was accountable
 *                                 for zero task-list instances dated in the
 *                                 window.
 *   six counts                    always integers; 0 is an honest "none in
 *                                 this window", not a floor state.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Auth: `Authorization: Bearer <SCORES_FEED_TOKEN>` — same token and
 * pattern as /api/scores; the route does its own auth and queries via the
 * service-role client, and rides proxy.ts's existing prefix allowlist for
 * /api/scores (startsWith — no proxy diff needed).
 */

export const dynamic = "force-dynamic";
// Worst case (full 50-row page x eight-table fan-out) is compute-bound;
// same ceiling as the Overview full-purview pull.
export const maxDuration = 300;

/** computeMetricsForRange fan-out width (kickoff §4: small cap, ~5). */
const RANGE_CONCURRENCY = 5;

/** Membership-probe page cap (PostgREST hard-caps a page at 1000 rows). */
const PROBE_PAGE = 1000;
/** Membership-probe IN-list chunk (keeps the querystring well-formed). */
const PROBE_CHUNK = 150;

interface MemberEmployee {
  id: string;
  employee_code: string;
  employee_name: string;
  location_id: string;
  location_code: string;
}

type ProbeQuery = (ids: string[]) => PromiseLike<{
  data: Array<{ employee_id: string }> | null;
  error: { message: string } | null;
}>;

/**
 * Mark every candidate id that SOURCE has rows for in the window. Works in
 * IN-list chunks; when a chunk's page comes back full (1000 rows) the found
 * ids are removed and the remainder re-queried, so heavy-hitter employees
 * (e.g. daily time entries over a year) can't hide the rest of the chunk
 * behind the page cap. Already-known members are skipped — any one source
 * is enough for membership.
 */
async function probeSource(
  label: string,
  query: ProbeQuery,
  candidates: string[],
  members: Set<string>
): Promise<void> {
  let remaining = candidates.filter((id) => !members.has(id));
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, PROBE_CHUNK);
    const rest = remaining.slice(PROBE_CHUNK);
    const { data, error } = await query(chunk);
    if (error) throw new Error(`${label} probe failed: ${error.message}`);
    const found = new Set((data ?? []).map((r) => r.employee_id));
    for (const id of found) members.add(id);
    if ((data ?? []).length >= PROBE_PAGE && found.size < chunk.length) {
      // Page overflowed before covering the chunk — requeue the unseen part.
      remaining = [...chunk.filter((id) => !found.has(id)), ...rest];
      if (found.size === 0) return; // defensive: rows must belong to chunk
    } else {
      remaining = rest;
    }
  }
}

/** Which candidates have ANY relevant rows in [start, end]? */
async function probeMembership(
  supabase: SupabaseClient,
  candidateIds: string[],
  start: string,
  end: string
): Promise<Set<string>> {
  const members = new Set<string>();

  await probeSource(
    "time_entries",
    (ids) =>
      supabase
        .from("time_entries")
        .select("employee_id")
        .in("employee_id", ids)
        .gte("entry_date", start)
        .lte("entry_date", end)
        .limit(PROBE_PAGE),
    candidateIds,
    members
  );
  // THE FLIP (2026-08-25): at Toast stores the attendance evidence lives in
  // toast_time_entries + seven_shifts_shifts — an employee whose only
  // window data is punches (hired post-flip) must not vanish from the
  // feed's membership. Same has-data semantics, two more sources; the wire
  // shape is untouched (range-feed-contract pins it).
  await probeSource(
    "toast_time_entries",
    (ids) =>
      supabase
        .from("toast_time_entries")
        .select("employee_id")
        .in("employee_id", ids)
        .eq("deleted", false)
        .gte("entry_date", start)
        .lte("entry_date", end)
        .limit(PROBE_PAGE),
    candidateIds,
    members
  );
  await probeSource(
    "seven_shifts_shifts",
    (ids) =>
      supabase
        .from("seven_shifts_shifts")
        .select("employee_id")
        .in("employee_id", ids)
        .is("missing_upstream_since", null)
        .eq("deleted", false)
        .eq("draft", false)
        .gte("entry_date", start)
        .lte("entry_date", end)
        .limit(PROBE_PAGE),
    candidateIds,
    members
  );
  await probeSource(
    "tattle_attributions",
    (ids) =>
      supabase
        .from("tattle_attributions")
        .select("employee_id, tattle_surveys!inner(date_experienced)")
        .in("employee_id", ids)
        .gte("tattle_surveys.date_experienced", start)
        .lte("tattle_surveys.date_experienced", end)
        .limit(PROBE_PAGE),
    candidateIds,
    members
  );
  await probeSource(
    "review_attributions",
    (ids) =>
      supabase
        .from("review_attributions")
        .select("employee_id, customer_reviews!inner(review_date)")
        .in("employee_id", ids)
        .gte("customer_reviews.review_date", start)
        .lte("customer_reviews.review_date", end)
        .limit(PROBE_PAGE),
    candidateIds,
    members
  );
  await probeSource(
    "survey_assignments",
    (ids) =>
      supabase
        .from("survey_assignments")
        .select("employee_id, surveys!inner(sent_date)")
        .in("employee_id", ids)
        .gte("surveys.sent_date", start)
        .lte("surveys.sent_date", end)
        .limit(PROBE_PAGE),
    candidateIds,
    members
  );
  await probeSource(
    "task_accountability",
    (ids) =>
      supabase
        .from("task_accountability")
        .select("employee_id, tasks!inner(task_date)")
        .in("employee_id", ids)
        .gte("tasks.task_date", start)
        .lte("tasks.task_date", end)
        .limit(PROBE_PAGE),
    candidateIds,
    members
  );

  return members;
}

export async function GET(request: Request) {
  const denied = requireBearer(
    request,
    process.env.SCORES_FEED_TOKEN,
    "SCORES_FEED_TOKEN"
  );
  if (denied) return denied;

  const url = new URL(request.url);
  const validated = validateRangeParams(url.searchParams);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.reason }, { status: 400 });
  }
  const { start, end, locationCodes, employeeCode, page, limit } =
    validated.params;

  const supabase = createAdminClient();

  try {
    // Locations: the filter set, or all eight.
    const codes = locationCodes.length > 0 ? locationCodes : LOCATION_CODES;
    const { data: locations, error: locErr } = await supabase
      .from("locations")
      .select("id, location_code")
      .in("location_code", codes);
    if (locErr) throw new Error(`locations query failed: ${locErr.message}`);
    const codeByLocationId = new Map<string, string>(
      (locations ?? []).map((l) => [l.id as string, l.location_code as string])
    );

    // Candidates: every employee at those locations, ACTIVE OR NOT — the
    // population rule is data-in-window, so a departed employee with rows
    // in a historical window still appears. Paged past the PostgREST
    // 1000-row cap (Codex review): an unpaginated fetch would silently
    // drop members once headcount outgrows one page.
    const candidates: MemberEmployee[] = [];
    for (let from = 0; ; from += PROBE_PAGE) {
      let empQuery = supabase
        .from("employees")
        .select("id, employee_code, employee_name, location_id")
        .in("location_id", [...codeByLocationId.keys()])
        .order("id", { ascending: true })
        .range(from, from + PROBE_PAGE - 1);
      if (employeeCode) empQuery = empQuery.eq("employee_code", employeeCode);
      const { data: employees, error: empErr } = await empQuery;
      if (empErr) throw new Error(`employees query failed: ${empErr.message}`);
      for (const e of employees ?? []) {
        candidates.push({
          id: e.id as string,
          employee_code: e.employee_code as string,
          employee_name: e.employee_name as string,
          location_id: e.location_id as string,
          location_code: codeByLocationId.get(e.location_id as string) ?? "",
        });
      }
      if ((employees ?? []).length < PROBE_PAGE) break;
    }

    const memberIds = await probeMembership(
      supabase,
      candidates.map((c) => c.id),
      start,
      end
    );
    const members = candidates
      .filter((c) => memberIds.has(c.id))
      .sort(compareRangeFeedMembers);

    const count = members.length;
    const pageMembers = members.slice((page - 1) * limit, page * limit);

    // Weights are singleton config — fetch once, share across the fan-out
    // (computeMetricsForRange would otherwise re-fetch per employee).
    const [csWeights, tisWeights] = await Promise.all([
      fetchCustomerServiceWeights(supabase),
      fetchTotalImpactWeights(supabase),
    ]);

    const rows: RangeFeedRow[] = new Array(pageMembers.length);
    const queue = pageMembers.map((m, i) => ({ m, i }));
    let computeError: string | null = null;
    async function worker() {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        const computed = await computeMetricsForRange(
          supabase,
          job.m.id,
          job.m.location_id,
          start,
          end,
          { csWeights, tisWeights }
        );
        if (!computed.ok) {
          computeError = `compute failed for ${job.m.employee_code}: ${computed.error}`;
          return;
        }
        rows[job.i] = toRangeFeedRow(job.m, computed.metrics);
      }
    }
    await Promise.all(
      Array.from({ length: RANGE_CONCURRENCY }, () => worker())
    );
    if (computeError) throw new Error(computeError);

    return NextResponse.json({
      data: rows,
      pagination: { page, limit, count },
      range: { start, end },
      computed_at: new Date().toISOString(),
    });
  } catch (e) {
    // Log the underlying error server-side; never leak internals to the
    // external consumer (same posture as /api/scores).
    console.error("[range-feed] request failed", {
      start,
      end,
      location_codes: locationCodes,
      employee_code: employeeCode,
      page,
      limit,
      message: (e as Error).message,
    });
    return NextResponse.json(
      { error: "Internal error computing range scores" },
      { status: 500 }
    );
  }
}
