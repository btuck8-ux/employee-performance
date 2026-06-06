/**
 * One-off backfill: employees.seven_shifts_user_id
 * ------------------------------------------------
 * Bridges EPD employees to 7shifts users by email (case-insensitive), per
 * company — the proven 6/4 email bridge. After this runs, nightly time/receipt
 * ingest joins on (seven_shifts_user_id + location_id) instead of name strings.
 *
 * OPTIONAL / ad-hoc. The nightly cron now self-resolves identities at the start
 * of every run (src/lib/ingest/sevenshifts/identities.ts), so you normally do
 * NOT need this script. It remains for one-off local runs / audits.
 *
 * Idempotent — safe to re-run; it only sets the column.
 *
 * Requires env (provided DIRECTLY — note `vercel env pull` returns EMPTY values
 * for Sensitive vars like these tokens, so pulling does NOT work):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   IKES_CULTUREPULSE          (token A: companies 360494, 185592)
 *   IKES_CULTUREPULSE_HOUSTON  (token B: company 62064)
 *
 * Run (Node 24 strips TS types natively), exporting the tokens yourself:
 *   export IKES_CULTUREPULSE=... IKES_CULTUREPULSE_HOUSTON=...
 *   node --env-file=.env.local scripts/backfill-seven-shifts-user-id.ts --dry
 *   node --env-file=.env.local scripts/backfill-seven-shifts-user-id.ts
 *
 * Flags: --dry   preview matches without writing.
 */

import { createClient } from "@supabase/supabase-js";

const DRY = process.argv.includes("--dry");

const SEVEN_SHIFTS_BASE = "https://api.7shifts.com";
const SEVEN_SHIFTS_API_VERSION = "2025-03-01";

const TOKEN_A_COMPANIES = new Set([360494, 185592]);
const TOKEN_B_COMPANIES = new Set([62064]);

function tokenForCompany(companyId: number): string {
  let envName: string | null = null;
  if (TOKEN_A_COMPANIES.has(companyId)) envName = "IKES_CULTUREPULSE";
  else if (TOKEN_B_COMPANIES.has(companyId)) envName = "IKES_CULTUREPULSE_HOUSTON";
  if (!envName) throw new Error(`No token route for company_id ${companyId}`);
  const token = process.env[envName];
  if (!token) throw new Error(`Env ${envName} is not set`);
  return token;
}

interface SevenShiftsUser {
  id: number;
  email: string | null;
  first_name?: string | null;
  last_name?: string | null;
  active?: boolean;
}

async function fetchAllUsers(companyId: number): Promise<SevenShiftsUser[]> {
  const token = tokenForCompany(companyId);
  const out: SevenShiftsUser[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const url = new URL(`${SEVEN_SHIFTS_BASE}/v2/company/${companyId}/users`);
    url.searchParams.set("limit", "500");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-api-version": SEVEN_SHIFTS_API_VERSION,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`7shifts users ${res.status} (company ${companyId}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      data: SevenShiftsUser[];
      meta?: { cursor?: { next?: string | null } };
    };
    if (Array.isArray(json.data)) out.push(...json.data);
    cursor = json.meta?.cursor?.next ?? undefined;
    pages += 1;
    if (cursor) await new Promise((r) => setTimeout(r, 120));
  } while (cursor && pages < 100);
  return out;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`[backfill] mode: ${DRY ? "DRY RUN (no writes)" : "WRITE"}`);

  // Locations with their 7shifts company id.
  const { data: locs, error: locErr } = await supabase
    .from("locations")
    .select("id, name, location_code, seven_shifts_company_id")
    .not("seven_shifts_company_id", "is", null)
    .order("location_code");
  if (locErr) throw new Error(`load locations: ${locErr.message}`);
  if (!locs || locs.length === 0) {
    console.log("[backfill] no wired locations found; did migration 030 apply?");
    return;
  }

  // Fetch users once per distinct company, build email -> user_id map.
  const companies = [...new Set(locs.map((l) => Number(l.seven_shifts_company_id)))];
  const emailToUser = new Map<number, Map<string, SevenShiftsUser>>(); // companyId -> (lower email -> user)
  const matchedUserIdsByCompany = new Map<number, Set<number>>();
  for (const companyId of companies) {
    const users = await fetchAllUsers(companyId);
    const map = new Map<string, SevenShiftsUser>();
    for (const u of users) {
      if (!u.email) continue;
      map.set(u.email.trim().toLowerCase(), u);
    }
    emailToUser.set(companyId, map);
    matchedUserIdsByCompany.set(companyId, new Set());
    console.log(`[backfill] company ${companyId}: ${users.length} users (${map.size} with email)`);
  }

  let totalMatched = 0;
  let totalUnmatchedEmployees = 0;
  const unmatchedEmployeesByLoc: Record<string, string[]> = {};

  for (const loc of locs) {
    const companyId = Number(loc.seven_shifts_company_id);
    const map = emailToUser.get(companyId)!;
    const matchedSet = matchedUserIdsByCompany.get(companyId)!;

    const { data: emps, error: empErr } = await supabase
      .from("employees")
      .select("id, employee_name, email")
      .eq("location_id", loc.id);
    if (empErr) throw new Error(`load employees @ ${loc.location_code}: ${empErr.message}`);

    const updates: Array<{ id: string; seven_shifts_user_id: number }> = [];
    const unmatched: string[] = [];
    for (const e of emps ?? []) {
      const email = (e.email as string | null)?.trim().toLowerCase();
      const user = email ? map.get(email) : undefined;
      if (!user) {
        unmatched.push(`${e.employee_name}${email ? ` <${email}>` : " (no email)"}`);
        continue;
      }
      updates.push({ id: e.id as string, seven_shifts_user_id: user.id });
      matchedSet.add(user.id);
    }

    if (!DRY) {
      for (const u of updates) {
        const { error } = await supabase
          .from("employees")
          .update({ seven_shifts_user_id: u.seven_shifts_user_id })
          .eq("id", u.id);
        if (error) console.error(`[backfill] update ${u.id} failed: ${error.message}`);
      }
    }

    totalMatched += updates.length;
    totalUnmatchedEmployees += unmatched.length;
    if (unmatched.length > 0) unmatchedEmployeesByLoc[loc.location_code] = unmatched;
    console.log(
      `[backfill] ${loc.location_code} (${loc.name}): matched ${updates.length}, unmatched ${unmatched.length}`
    );
  }

  // Unmatched 7shifts users (in a company but no EPD employee with that email).
  console.log("\n[backfill] ===== UNMATCHED 7SHIFTS USERS (review) =====");
  for (const companyId of companies) {
    const map = emailToUser.get(companyId)!;
    const matchedSet = matchedUserIdsByCompany.get(companyId)!;
    const unmatchedUsers = [...map.values()].filter((u) => !matchedSet.has(u.id) && u.active !== false);
    console.log(`  company ${companyId}: ${unmatchedUsers.length} active users with no EPD match`);
    for (const u of unmatchedUsers.slice(0, 50)) {
      console.log(`    - ${u.first_name ?? ""} ${u.last_name ?? ""} <${u.email}> (user_id ${u.id})`);
    }
  }

  console.log("\n[backfill] ===== UNMATCHED EPD EMPLOYEES (review) =====");
  for (const [code, names] of Object.entries(unmatchedEmployeesByLoc)) {
    console.log(`  ${code}: ${names.length}`);
    for (const n of names.slice(0, 50)) console.log(`    - ${n}`);
  }

  console.log(
    `\n[backfill] DONE. matched=${totalMatched}, unmatched_employees=${totalUnmatchedEmployees}, mode=${DRY ? "dry" : "write"}`
  );
}

main().catch((err) => {
  console.error("[backfill] FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
