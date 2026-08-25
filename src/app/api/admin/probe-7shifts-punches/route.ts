import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCrosswalk } from "@/lib/ingest/sevenshifts/crosswalk";
import { getAllWithMeta } from "@/lib/ingest/sevenshifts/client";

/**
 * §4 — the Q2 punch probe (Q2 punch-recovery spec REVISED 2, 2026-08-25).
 * READ-ONLY: no writes to any table, shapes and counts only — no names, no
 * emails, no token material (the probe-7shifts-shifts pattern; CRON_SECRET,
 * run from the deployed app where the Sensitive 7shifts tokens live).
 *
 * THE QUESTION: which 7shifts resource + parameters return the blind
 * cohort's Q2 worked hours? 230 of Q2's 458 gap days belong to employees
 * whose punches EPD has never seen (§3d) — before any ingest change or
 * manual export, this probe must say whether the API can serve them at all.
 * NOTHING GETS BUILT BEFORE THAT ANSWER EXISTS.
 *
 * Three subjects, three failure modes (§4; Taggart Dickson removed — §7a
 * resolved him, probing him would spend budget confirming a man at college
 * did not clock in):
 *   11138104  Chazz Limon   DTD    54 Q2 scheduled, zero punches EVER —
 *                                  "can we see this person at all"
 *   10437864  Keara Beck    HRANCH 23 blind days ending 05-10, clean from
 *                                  05-13 — the onset shape. ⚠️ §4a: one of
 *                                  SIX people with two employee rows on one
 *                                  7shifts id; the split-identity hypothesis
 *                                  is already DEAD (0 of 23 days on her
 *                                  other row) — do not re-run it.
 *   11261591  Layla Brown   LONGM  22 blind days 04-14→06-22, first punch
 *                                  06-23 — a second onset at another store,
 *                                  to tell per-employee from per-store.
 *
 * FOUR CANDIDATE CAUSES, each independently tested. Report what EACH
 * returns; do not stop at the first that looks plausible:
 *   T1 the location_id filter — re-query WITHOUT it, report the distinct
 *      location_ids these users' punches actually carry.
 *   T2 modified_since semantics — floor 2026-01-01; if modified stamps are
 *      set at approval or absent on old rows, the param excludes exactly
 *      what a backfill needs. Plus clocked_in[gte/lte] as a candidate
 *      entry-date param.
 *   T3 a different resource — "Worked Hours and Wages" may not be built on
 *      time_punches. Enumerate candidates, report which return rows.
 *      This remains the most likely answer (Tucker's suspicion: pre-Toast
 *      worked time may need a different path).
 *   T4 user-id association — a user_id-filtered punch query; verifies the
 *      ids are punch-associated, and detects a silently-ignored param by
 *      checking whether returned rows actually match.
 *
 * AUTH: Bearer <CRON_SECRET>.
 *   GET /api/admin/probe-7shifts-punches
 *     ?subjects=11138104,10437864,11261591   optional override
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_SUBJECTS = [11138104, 10437864, 11261591];
const Q2_START = "2026-04-01";
const Q2_END = "2026-06-30";
const DEEP_FLOOR = "2026-01-01";
const LIST_LIMIT = 100;
const WIDE_MAX_PAGES = 100;
const NARROW_MAX_PAGES = 40;

interface PunchRow {
  id?: number;
  user_id?: number;
  location_id?: number;
  clocked_in?: string | null;
  clocked_out?: string | null;
  modified?: string | null;
  [k: string]: unknown;
}

const WORKED_TIME_KEY_RE = /actual|clock|punch|work|hour|wage|approved/i;

function datePart(v: unknown): string | null {
  if (typeof v !== "string" || v.length < 10) return null;
  const d = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/** Per-subject rollup of a punch list: counts + date bounds + locations —
 * numbers and dates only, never payload values. */
function rollup(rows: PunchRow[], subjects: number[]) {
  const bySubject: Record<
    string,
    {
      rows: number;
      distinct_location_ids: number[];
      min_clocked_in: string | null;
      max_clocked_in: string | null;
      q2_rows: number;
    }
  > = {};
  for (const s of subjects) {
    bySubject[String(s)] = {
      rows: 0,
      distinct_location_ids: [],
      min_clocked_in: null,
      max_clocked_in: null,
      q2_rows: 0,
    };
  }
  for (const r of rows) {
    const uid = Number(r.user_id);
    const agg = bySubject[String(uid)];
    if (!agg) continue;
    agg.rows += 1;
    const locId = Number(r.location_id);
    if (Number.isFinite(locId) && !agg.distinct_location_ids.includes(locId)) {
      agg.distinct_location_ids.push(locId);
    }
    const d = datePart(r.clocked_in);
    if (d) {
      if (!agg.min_clocked_in || d < agg.min_clocked_in) agg.min_clocked_in = d;
      if (!agg.max_clocked_in || d > agg.max_clocked_in) agg.max_clocked_in = d;
      if (d >= Q2_START && d <= Q2_END) agg.q2_rows += 1;
    }
  }
  return bySubject;
}

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const subjects = (url.searchParams.get("subjects") ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const subjectIds = subjects.length > 0 ? subjects : DEFAULT_SUBJECTS;

  const supabase = createAdminClient();

  try {
    const crosswalk = await loadCrosswalk(supabase);

    // Resolve each subject's company + 7shifts location(s) via the roster —
    // §4a means a subject can resolve to TWO rows; every combination is
    // probed and reported separately.
    type SubjectSite = {
      seven_shifts_user_id: number;
      company_id: number;
      seven_shifts_location_id: number;
      location_code: string;
    };
    const sites: SubjectSite[] = [];
    for (const uid of subjectIds) {
      const { data: empRows, error } = await supabase
        .from("employees")
        .select("location_id")
        .eq("seven_shifts_user_id", uid);
      if (error) throw new Error(`subject lookup ${uid}: ${error.message}`);
      for (const r of empRows ?? []) {
        const loc = crosswalk.find((l) => l.id === String(r.location_id));
        if (loc) {
          sites.push({
            seven_shifts_user_id: uid,
            company_id: loc.company_id,
            seven_shifts_location_id: loc.seven_shifts_location_id,
            location_code: loc.location_code,
          });
        }
      }
    }
    const companies = [...new Set(sites.map((s) => s.company_id))];

    // ---- T1: the location_id filter — company-wide pull, NO location ----
    const t1: Record<string, unknown> = {};
    for (const companyId of companies) {
      try {
        const { data, truncated } = await getAllWithMeta<PunchRow>(
          companyId,
          "time_punches",
          { modified_since: `${Q2_START}T00:00:00.000Z`, limit: LIST_LIMIT },
          WIDE_MAX_PAGES
        );
        t1[String(companyId)] = {
          rows_fetched: data.length,
          truncated_at_page_cap: truncated,
          by_subject: rollup(data, subjectIds),
        };
      } catch (err) {
        t1[String(companyId)] = {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // ---- T2: modified_since floor + entry-date param candidates ----
    const t2: Record<string, unknown> = {};
    for (const site of sites) {
      const key = `${site.seven_shifts_user_id}@${site.location_code}`;
      try {
        const deep = await getAllWithMeta<PunchRow>(
          site.company_id,
          "time_punches",
          {
            location_id: site.seven_shifts_location_id,
            modified_since: `${DEEP_FLOOR}T00:00:00.000Z`,
            limit: LIST_LIMIT,
          },
          NARROW_MAX_PAGES
        );
        const clockedParam = await getAllWithMeta<PunchRow>(
          site.company_id,
          "time_punches",
          {
            location_id: site.seven_shifts_location_id,
            "clocked_in[gte]": Q2_START,
            "clocked_in[lte]": Q2_END,
            limit: LIST_LIMIT,
          },
          NARROW_MAX_PAGES
        );
        t2[key] = {
          deep_modified_since: {
            floor: DEEP_FLOOR,
            rows_fetched: deep.data.length,
            truncated_at_page_cap: deep.truncated,
            by_subject: rollup(deep.data, [site.seven_shifts_user_id]),
          },
          clocked_in_range_param: {
            rows_fetched: clockedParam.data.length,
            truncated_at_page_cap: clockedParam.truncated,
            by_subject: rollup(clockedParam.data, [site.seven_shifts_user_id]),
            note: "if rows_fetched ignores the param, min/max dates in by_subject will say so",
          },
        };
      } catch (err) {
        t2[key] = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    // ---- T3: alternative resources for worked time ----
    const CANDIDATE_PATHS = [
      "time_punches",
      "shifts",
      "timesheets",
      "worked_hours",
      "hours_and_wages",
      "reports/hours_and_wages",
      "labor/hours",
    ];
    const t3: Record<string, unknown> = {};
    for (const companyId of companies) {
      const perPath: Record<string, unknown> = {};
      for (const path of CANDIDATE_PATHS) {
        try {
          const { data, truncated } = await getAllWithMeta<PunchRow>(
            companyId,
            path,
            path === "shifts"
              ? { "start[gte]": Q2_START, "start[lte]": Q2_END, limit: LIST_LIMIT }
              : { modified_since: `${Q2_START}T00:00:00.000Z`, limit: LIST_LIMIT },
            10
          );
          // Key discovery: names + non-null counts only — never values.
          const keyCounts: Record<string, number> = {};
          for (const row of data.slice(0, 500)) {
            for (const [k, v] of Object.entries(row)) {
              if (WORKED_TIME_KEY_RE.test(k) && v !== null && v !== undefined) {
                keyCounts[k] = (keyCounts[k] ?? 0) + 1;
              }
            }
          }
          perPath[path] = {
            ok: true,
            rows_fetched: data.length,
            truncated_at_page_cap: truncated,
            worked_time_shaped_keys: keyCounts,
            subject_rows: rollup(data, subjectIds),
          };
        } catch (err) {
          perPath[path] = {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
      t3[String(companyId)] = perPath;
    }

    // ---- T4: user-id association / ignored-param detection ----
    const t4: Record<string, unknown> = {};
    for (const site of sites) {
      const key = `${site.seven_shifts_user_id}@${site.location_code}`;
      try {
        const { data, truncated } = await getAllWithMeta<PunchRow>(
          site.company_id,
          "time_punches",
          {
            user_id: site.seven_shifts_user_id,
            modified_since: `${DEEP_FLOOR}T00:00:00.000Z`,
            limit: LIST_LIMIT,
          },
          NARROW_MAX_PAGES
        );
        const matching = data.filter(
          (r) => Number(r.user_id) === site.seven_shifts_user_id
        ).length;
        t4[key] = {
          rows_fetched: data.length,
          rows_matching_subject: matching,
          param_respected: data.length === 0 || matching === data.length,
          truncated_at_page_cap: truncated,
        };
      } catch (err) {
        t4[key] = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    return NextResponse.json({
      probe: "7shifts-punches",
      subjects: subjectIds,
      subject_sites: sites.map((s) => ({
        seven_shifts_user_id: s.seven_shifts_user_id,
        location_code: s.location_code,
        company_id: s.company_id,
      })),
      q2_window: { start: Q2_START, end: Q2_END },
      t1_location_filter: t1,
      t2_modified_since_and_entry_date_params: t2,
      t3_alternative_resources: t3,
      t4_user_id_association: t4,
      deliverable:
        "which resource + parameters return these employees' Q2 worked hours, with row counts per candidate — nothing gets built before this answer exists (§4)",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[probe-7shifts-punches] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
