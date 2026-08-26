import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * App-side role checks for the 5-tier RBAC model (migration 046).
 *
 * Every function here is a thin wrapper over the canonical security-definer
 * SQL helpers (`epd_user_role`, `epd_can_read_employee`, ...) — the SAME
 * source of truth the RLS policies read. Never reimplement scope logic in
 * TypeScript: a parallel implementation can drift (TS↔SQL lockstep rule,
 * AGENTS.md).
 *
 * All lookups fail CLOSED: signed-out, missing user_roles row (e.g. an
 * uninvited Google login), or an RPC error all read as "no access".
 */

export type EpdRole =
  | "system_admin"
  | "regional_admin"
  | "area_admin"
  | "manager"
  | "user"
  // Sixth shared value (CSU memo §6, 2026-08-26): a ROSTER state, never a
  // grantable login role (mig 077 CHECK rejects it on user_roles) — but an
  // employee-BACKED login whose row is unclassified derives it through
  // epd_user_role(), so the union must model it. Resolves to zero
  // authorized locations (fails closed) until a human classifies the row.
  | "unclassified";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export async function getSessionRole(): Promise<{
  supabase: SupabaseServerClient;
  user: User | null;
  role: EpdRole | null;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, role: null };

  // Zero-arg: the SQL helper reads auth.uid() from the caller's JWT, so a
  // session can only ever ask about itself (Codex Phase A finding).
  const { data, error } = await supabase.rpc("epd_user_role");
  if (error) {
    console.error("[authz] epd_user_role rpc failed", { message: error.message });
    return { supabase, user, role: null };
  }
  return { supabase, user, role: (data as EpdRole | null) ?? null };
}

/**
 * May the calling session read rows about (employee, location)? Row-level
 * only — pay fields ride along for every admin/manager tier (locked decision
 * 2, 2026-08-10). User tier matches only its own linked employee_id.
 */
export async function canReadEmployee(
  supabase: SupabaseServerClient,
  employeeId: string,
  locationId: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc("epd_can_read_employee", {
    emp_id: employeeId,
    loc_id: locationId,
  });
  if (error) {
    console.error("[authz] epd_can_read_employee rpc failed", {
      message: error.message,
    });
    return false;
  }
  return data === true;
}
