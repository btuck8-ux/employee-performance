import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCrosswalk } from "@/lib/ingest/sevenshifts/crosswalk";
import { getAll, getOne } from "@/lib/ingest/sevenshifts/client";

/**
 * STEP 0 probe for the hire-date-from-7shifts feed (kickoff 2026-08-17 §3).
 *
 * READ-ONLY — no writes, no migration. Answers, per non-NOLA company (NOLA
 * rides CAKE and is excluded from the 7shifts fan-out; its hire dates come
 * from the earliest-entry fallback only):
 *
 *  1. Does the GET /users payload carry a hire date (or equivalently named
 *     field) at all? Reports the union of payload keys plus every candidate
 *     field matching /hire|start_?date|employment/i with non-null counts and
 *     a few raw sample values.
 *  2. Coverage against our roster: of the employees with a
 *     seven_shifts_user_id at that company's stores, how many appear in the
 *     payload, and how many of those carry a usable hire date?
 *  3. Agreement vs stored: where BOTH a stored hire_date and a 7shifts value
 *     exist, do they match? Diffs are listed (employee_code, stored → 7shifts,
 *     capped) so the §2.1 overwrite ruling's blast radius is visible BEFORE
 *     any write path exists.
 *  4. Date sanity for §6-A (re-stamp semantics): min/max payload hire dates
 *     and counts of clearly-bogus values (pre-2000 or in the future).
 *  5. Detail-endpoint sample: the LIST payload proved to carry no hire-date
 *     field on the first run, so the probe also GETs /users/{id} for a few
 *     roster-matched users per company — the detail object can carry fields
 *     the list omits. Keys + hire-shaped values reported per sample.
 *
 * Fetches users with the exact same call identities.ts uses (same params),
 * so the probe sees the same payload the nightly write path would.
 * Never echoes names, emails, or tokens — samples are date strings and
 * employee_codes only.
 *
 * AUTH: Bearer <CRON_SECRET>.
 *   GET /api/admin/probe-7shifts-hire-date
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HIRE_KEY_RE = /hire|start_?date|employment/i;
const DIFF_SAMPLE_CAP = 40;
const VALUE_SAMPLE_CAP = 5;

type UserRow = Record<string, unknown>;

interface RosterRow {
  employee_code: string;
  hire_date: string | null;
  active: boolean;
  seven_shifts_user_id: number | null;
  location_id: string;
}

/** Normalize a payload hire-date value to YYYY-MM-DD for comparison. */
function datePart(v: unknown): string | null {
  if (typeof v !== "string" || v.length < 10) return null;
  const d = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function probeCompany(
  companyId: number,
  users: UserRow[],
  roster: RosterRow[]
) {
  // 1. Field discovery — every key seen, plus hire-date-shaped candidates.
  const allKeys = new Set<string>();
  const candidateStats = new Map<
    string,
    { non_null: number; samples: string[] }
  >();
  for (const u of users) {
    for (const [k, v] of Object.entries(u)) {
      allKeys.add(k);
      if (!HIRE_KEY_RE.test(k)) continue;
      let stat = candidateStats.get(k);
      if (!stat) {
        stat = { non_null: 0, samples: [] };
        candidateStats.set(k, stat);
      }
      if (v != null && v !== "") {
        stat.non_null += 1;
        const s = String(v);
        if (stat.samples.length < VALUE_SAMPLE_CAP && !stat.samples.includes(s))
          stat.samples.push(s);
      }
    }
  }

  // Best candidate = the hire-shaped key with the most non-null values.
  const best = [...candidateStats.entries()].sort(
    (a, b) => b[1].non_null - a[1].non_null
  )[0];
  const bestKey = best && best[1].non_null > 0 ? best[0] : null;

  const byUserId = new Map<number, UserRow>();
  for (const u of users) {
    const id = typeof u["id"] === "number" ? (u["id"] as number) : NaN;
    if (Number.isFinite(id)) byUserId.set(id, u);
  }

  // 2 + 3. Roster coverage and stored-vs-7shifts agreement.
  const coverage = {
    roster_with_seven_shifts_user_id: 0,
    matched_in_payload: 0,
    with_7shifts_hire_date: 0,
    without_7shifts_hire_date: 0,
    missing_from_payload: 0,
  };
  const agreement = {
    same: 0,
    differ: 0,
    stored_null_payload_present: 0,
    stored_present_payload_null: 0,
  };
  const diffs: Array<{
    employee_code: string;
    stored: string;
    seven_shifts: string;
  }> = [];

  for (const e of roster) {
    if (e.seven_shifts_user_id == null) continue;
    coverage.roster_with_seven_shifts_user_id += 1;
    const user = byUserId.get(e.seven_shifts_user_id);
    if (!user) {
      coverage.missing_from_payload += 1;
      continue;
    }
    coverage.matched_in_payload += 1;
    const payloadDate = bestKey ? datePart(user[bestKey]) : null;
    if (payloadDate) coverage.with_7shifts_hire_date += 1;
    else coverage.without_7shifts_hire_date += 1;

    const stored = e.hire_date ? e.hire_date.slice(0, 10) : null;
    if (stored && payloadDate) {
      if (stored === payloadDate) agreement.same += 1;
      else {
        agreement.differ += 1;
        if (diffs.length < DIFF_SAMPLE_CAP)
          diffs.push({
            employee_code: e.employee_code,
            stored,
            seven_shifts: payloadDate,
          });
      }
    } else if (!stored && payloadDate) {
      agreement.stored_null_payload_present += 1;
    } else if (stored && !payloadDate) {
      agreement.stored_present_payload_null += 1;
    }
  }

  // 4. Date sanity across the whole payload (§6-A volatility read).
  let min: string | null = null;
  let max: string | null = null;
  let bogus = 0;
  let withDate = 0;
  if (bestKey) {
    for (const u of users) {
      const d = datePart(u[bestKey]);
      if (!d) continue;
      withDate += 1;
      if (min === null || d < min) min = d;
      if (max === null || d > max) max = d;
      if (d < "2000-01-01" || d > "2027-12-31") bogus += 1;
    }
  }

  return {
    company_id: companyId,
    users_fetched: users.length,
    users_active: users.filter((u) => u["active"] !== false).length,
    payload_keys: [...allKeys].sort(),
    hire_date_candidates: Object.fromEntries(candidateStats),
    best_candidate_field: bestKey,
    payload_users_with_hire_date: withDate,
    coverage,
    agreement_vs_stored: agreement,
    diff_sample: diffs,
    date_sanity: { min, max, bogus_outside_2000_2027: bogus },
  };
}

const DETAIL_SAMPLE_CAP = 3;

/**
 * GET /users/{id} for a few roster-matched users. The list payload carries no
 * hire-date field, so this answers whether the detail object does.
 */
async function sampleUserDetails(companyId: number, userIds: number[]) {
  const samples = [];
  for (const id of userIds.slice(0, DETAIL_SAMPLE_CAP)) {
    try {
      const detail = await getOne<UserRow>(companyId, `users/${id}`);
      const hireShaped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(detail)) {
        if (HIRE_KEY_RE.test(k)) hireShaped[k] = v;
      }
      samples.push({
        user_id: id,
        keys: Object.keys(detail).sort(),
        hire_shaped_fields: hireShaped,
      });
    } catch (err) {
      samples.push({
        user_id: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return samples;
}

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  try {
    const supabase = createAdminClient();
    const crosswalk = await loadCrosswalk(supabase);
    const sevenShiftsLocs = crosswalk.filter(
      (l) => l.actuals_source === "7shifts"
    );
    const cakeLocs = crosswalk.filter((l) => l.actuals_source === "cake");
    const companyIds = [...new Set(sevenShiftsLocs.map((l) => l.company_id))];

    const { data: emps, error } = await supabase
      .from("employees")
      .select("employee_code, hire_date, active, seven_shifts_user_id, location_id");
    if (error) throw new Error(`employees fetch: ${error.message}`);
    const roster = (emps ?? []) as RosterRow[];

    const locsByCompany = new Map<number, Set<string>>();
    for (const l of sevenShiftsLocs) {
      let set = locsByCompany.get(l.company_id);
      if (!set) {
        set = new Set();
        locsByCompany.set(l.company_id, set);
      }
      set.add(l.id);
    }
    const cakeLocIds = new Set(cakeLocs.map((l) => l.id));

    const companies = [];
    for (const companyId of companyIds) {
      const locIds = locsByCompany.get(companyId) ?? new Set();
      const companyRoster = roster.filter((e) => locIds.has(e.location_id));
      try {
        // Same call identities.ts makes — the probe sees the nightly's payload.
        const users = await getAll<UserRow>(companyId, "users", { limit: 500 });
        const payloadIds = new Set(
          users.map((u) => u["id"]).filter((v): v is number => typeof v === "number")
        );
        const sampleIds = companyRoster
          .map((e) => e.seven_shifts_user_id)
          .filter((id): id is number => id != null && payloadIds.has(id));
        companies.push({
          ...probeCompany(companyId, users, companyRoster),
          detail_endpoint_samples: await sampleUserDetails(companyId, sampleIds),
        });
      } catch (err) {
        companies.push({
          company_id: companyId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const nolaRoster = roster.filter((e) => cakeLocIds.has(e.location_id));
    return NextResponse.json({
      probe: "7shifts-hire-date",
      note: "READ-ONLY — no writes. Write path is built only after Tucker reads this output (kickoff §3 Step 0).",
      companies,
      roster_context: {
        employees_total: roster.length,
        employees_active: roster.filter((e) => e.active).length,
        with_seven_shifts_user_id: roster.filter(
          (e) => e.seven_shifts_user_id != null
        ).length,
        hire_date_null: roster.filter((e) => !e.hire_date).length,
        // NOLA (CAKE actuals) is excluded from the 7shifts fan-out — for these
        // employees the earliest-entry fallback is the ONLY hire-date source.
        nola_fallback_only_pool: nolaRoster.length,
        nola_hire_date_null: nolaRoster.filter((e) => !e.hire_date).length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[probe-7shifts-hire-date] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
