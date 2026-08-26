import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * §7b (epd_role spec 2026-08-26): a departure is a person-level fact —
 * deactivating someone who holds rows at more than one store prompts "Also
 * deactivate at [other stores]?" and defaults to all (Micah Blakeley is
 * what the alternative produced). This helper finds the OTHER active roster
 * rows of the same person, correlated on seven_shifts_user_id (217 of 218
 * rows carry one; the exception simply gets no prompt).
 *
 * Runs on the caller's session client deliberately: RLS trims siblings to
 * the operator's purview, so the prompt offers exactly the stores the
 * server action could act on for this operator — never a store the
 * follow-up write would silently skip.
 */

export interface ActiveSiblingStore {
  employeeId: string;
  locationId: string;
  locationName: string;
}

/** Map of employee id → that person's OTHER active rows. One batched query. */
export async function fetchActiveSiblingStoresMap(
  supabase: SupabaseClient,
  employees: { id: string; seven_shifts_user_id: number | string | null }[]
): Promise<Map<string, ActiveSiblingStore[]>> {
  const map = new Map<string, ActiveSiblingStore[]>();
  const ids = [
    ...new Set(
      employees
        .map((e) => e.seven_shifts_user_id)
        .filter((v): v is number | string => v !== null && v !== undefined)
        .map((v) => Number(v))
        .filter((v) => Number.isSafeInteger(v))
    ),
  ];
  if (ids.length === 0) return map;

  const { data, error } = await supabase
    .from("employees")
    .select("id, seven_shifts_user_id, location_id, locations(name)")
    .in("seven_shifts_user_id", ids)
    .eq("active", true);
  if (error) throw new Error(`active-sibling read: ${error.message}`);

  type Row = {
    id: string;
    seven_shifts_user_id: number | string;
    location_id: string;
    locations: { name: string } | null;
  };
  const byPerson = new Map<number, Row[]>();
  for (const r of (data ?? []) as unknown as Row[]) {
    const key = Number(r.seven_shifts_user_id);
    byPerson.set(key, [...(byPerson.get(key) ?? []), r]);
  }

  for (const e of employees) {
    const key = Number(e.seven_shifts_user_id);
    if (!Number.isSafeInteger(key)) continue;
    const siblings = (byPerson.get(key) ?? [])
      .filter((r) => r.id !== e.id)
      .map((r) => ({
        employeeId: r.id,
        locationId: r.location_id,
        locationName: r.locations?.name ?? "—",
      }));
    if (siblings.length > 0) map.set(e.id, siblings);
  }
  return map;
}
