/**
 * Identity resolution: employees.seven_shifts_user_id, the per-person bridge.
 *
 * Runs at the START of every nightly ingest (in the Vercel runtime, where the
 * Sensitive 7shifts tokens are live but un-pullable). Idempotent: per company
 * it pulls GET /users once, matches each EPD employee with a null
 * seven_shifts_user_id to a 7shifts user by email (case-insensitive), and sets
 * the column. New hires get bridged automatically on the next run.
 *
 * This replaces the need to run scripts/backfill-seven-shifts-user-id.ts by
 * hand — that standalone script still exists for ad-hoc use where tokens are
 * available locally, but the cron no longer depends on it.
 *
 * The location-scoped join (user_id + location_id) at ingest time handles
 * shared emails across locations: the same user_id legitimately lands on
 * several employee rows.
 */

import { getAll } from "./client";
import type { AdminClient, LocationCrosswalk } from "./crosswalk";

interface SevenShiftsUser {
  id: number;
  email: string | null;
  first_name?: string | null;
  last_name?: string | null;
  active?: boolean;
}

export interface IdentityResolutionSummary {
  total_matched: number;
  per_company: Array<{
    company_id: number;
    users: number;
    users_with_email: number;
    unmatched_active_users: Array<{ id: number; name: string; email: string }>;
  }>;
  per_location: Array<{
    location_code: string;
    newly_matched: number;
    still_unmatched: string[];
  }>;
  errors: string[];
}

export async function resolveIdentities(
  supabase: AdminClient,
  crosswalk: LocationCrosswalk[]
): Promise<IdentityResolutionSummary> {
  const summary: IdentityResolutionSummary = {
    total_matched: 0,
    per_company: [],
    per_location: [],
    errors: [],
  };

  const companies = [...new Set(crosswalk.map((l) => l.company_id))];
  const emailMaps = new Map<number, Map<string, SevenShiftsUser>>();
  const matchedUserIds = new Map<number, Set<number>>();

  for (const companyId of companies) {
    try {
      const users = await getAll<SevenShiftsUser>(companyId, "users", { limit: 500 });
      const map = new Map<string, SevenShiftsUser>();
      for (const u of users) {
        if (!u.email) continue;
        map.set(u.email.trim().toLowerCase(), u);
      }
      emailMaps.set(companyId, map);
      matchedUserIds.set(companyId, new Set());
      summary.per_company.push({
        company_id: companyId,
        users: users.length,
        users_with_email: map.size,
        unmatched_active_users: [], // filled after location matching
      });
    } catch (err) {
      summary.errors.push(
        `users fetch company ${companyId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  for (const loc of crosswalk) {
    const map = emailMaps.get(loc.company_id);
    const matchedSet = matchedUserIds.get(loc.company_id);
    if (!map || !matchedSet) continue;

    const { data: emps, error } = await supabase
      .from("employees")
      .select("id, employee_name, email, seven_shifts_user_id")
      .eq("location_id", loc.id);
    if (error) {
      summary.errors.push(`employees @ ${loc.location_code}: ${error.message}`);
      continue;
    }

    let newlyMatched = 0;
    const stillUnmatched: string[] = [];
    for (const e of emps ?? []) {
      const email = (e.email as string | null)?.trim().toLowerCase();
      const user = email ? map.get(email) : undefined;
      if (user) matchedSet.add(user.id);

      // Only write when currently null and we found a match (idempotent).
      if (e.seven_shifts_user_id == null) {
        if (!user) {
          stillUnmatched.push(
            `${e.employee_name as string}${email ? "" : " (no email)"}`
          );
          continue;
        }
        const { error: upErr } = await supabase
          .from("employees")
          .update({ seven_shifts_user_id: user.id })
          .eq("id", e.id as string);
        if (upErr) {
          summary.errors.push(`set user_id ${e.id}: ${upErr.message}`);
          continue;
        }
        newlyMatched += 1;
        summary.total_matched += 1;
      }
    }
    summary.per_location.push({
      location_code: loc.location_code,
      newly_matched: newlyMatched,
      still_unmatched: stillUnmatched,
    });
  }

  // Active 7shifts users with no EPD employee sharing their email.
  for (const entry of summary.per_company) {
    const map = emailMaps.get(entry.company_id);
    const matchedSet = matchedUserIds.get(entry.company_id);
    if (!map || !matchedSet) continue;
    entry.unmatched_active_users = [...map.values()]
      .filter((u) => !matchedSet.has(u.id) && u.active !== false)
      .slice(0, 100)
      .map((u) => ({
        id: u.id,
        name: `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim(),
        email: u.email ?? "",
      }));
  }

  return summary;
}
