"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import {
  restampPunches,
  deattributeStoredPunches,
} from "@/lib/ingest/toast/labor";
import type { AdminClient } from "@/lib/ingest/sevenshifts/crosswalk";

/**
 * Confirm + undo for the Toast employee crosswalk (ruling §3/§4). Both
 * actions are system_admin-only and re-check server-side (server actions
 * are directly POSTable). Writes ride the AUTHENTICATED client on purpose —
 * toast_employee_crosswalk and toast_time_entries are SA-only under RLS
 * (mig 055), so the policy layer enforces what the code checks (the
 * employee-triage actions doctrine).
 *
 * The employee's LOCATION is validated server-side against the guid's
 * stored punches — the store a punch happened at is never client input
 * (Codex finding 2 doctrine from the mint surface). No name is read
 * anywhere here: the SA saw the hints on the card; the code only handles
 * ids.
 */

const BACK = "/dashboard/admin/toast-crosswalk";

/** Active state renders on the employees list, the profile, and the
 * location page — revalidate them all (the employee-status-actions
 * doctrine; Codex 2026-08-25), not just this surface. */
function revalidatePaths(employeeId: string): void {
  revalidatePath(BACK);
  revalidatePath("/dashboard/employees");
  revalidatePath(`/dashboard/employees/${employeeId}`);
}

function backWith(params: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  return `${BACK}?${p.toString()}`;
}

/** The location(s) the guid's stored punches actually belong to. */
async function punchLocationForGuid(
  supabase: AdminClient,
  guid: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("toast_time_entries")
    .select("location_id")
    .eq("toast_employee_guid", guid)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? String(data.location_id) : null;
}

export async function confirmToastMatchAction(formData: FormData) {
  const { role, user, supabase } = await getSessionRole();
  if (!user || role !== "system_admin") {
    console.warn("[toast-crosswalk] confirm denied (tier)", {
      user_id: user?.id ?? null,
      role,
    });
    redirect("/dashboard");
  }

  const guid = String(formData.get("toast_employee_guid") ?? "").trim();
  const employeeId = String(formData.get("employee_id") ?? "").trim();
  if (!guid || !employeeId) {
    redirect(backWith({ error: "Confirm needs a Toast employee and an EPD employee." }));
  }

  // The guid must still be unmatched (calm idempotency: a double-submit
  // reports the existing row, never overwrites it).
  const { data: existing, error: existErr } = await supabase
    .from("toast_employee_crosswalk")
    .select("employee_id")
    .eq("toast_employee_guid", guid)
    .maybeSingle();
  if (existErr) {
    redirect(backWith({ error: `Confirm pre-check failed: ${existErr.message}` }));
  }
  if (existing) {
    redirect(backWith({ already: "1" }));
  }

  // Server-derived location: where the punches are. The chosen employee
  // must be rostered at that store.
  let punchLocation: string | null = null;
  try {
    punchLocation = await punchLocationForGuid(supabase, guid);
  } catch (err) {
    redirect(
      backWith({
        error: `Confirm failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    );
  }
  if (!punchLocation) {
    redirect(
      backWith({
        error: "No stored punches for that Toast employee — refresh and re-check.",
      })
    );
  }
  const { data: emp, error: empErr } = await supabase
    .from("employees")
    .select("id, employee_code, location_id")
    .eq("id", employeeId)
    .eq("location_id", punchLocation)
    .maybeSingle();
  if (empErr) {
    redirect(backWith({ error: `Confirm failed: ${empErr.message}` }));
  }
  if (!emp) {
    redirect(
      backWith({
        error: "That employee isn't rostered at the store these punches belong to.",
      })
    );
  }

  const { error: insertErr } = await supabase.from("toast_employee_crosswalk").insert({
    toast_employee_guid: guid,
    employee_id: employeeId,
    location_id: punchLocation,
    match_method: "manual",
    confirmed_by: user.id,
    confirmed_at: new Date().toISOString(),
  });
  if (insertErr) {
    redirect(backWith({ error: `Confirm failed: ${insertErr.message}` }));
  }
  // §5e (defect 2026-08-24): re-stamp EVERY punch row for the guid — a
  // confirm that repoints a previously-wrong mapping must move rows already
  // stamped for someone else, not just the null ones.
  try {
    await restampPunches(supabase, guid, employeeId);
  } catch (err) {
    redirect(
      backWith({
        error: `Mapping saved but punch re-stamp failed — run /api/admin/restamp-toast-attributions: ${err instanceof Error ? err.message : String(err)}`,
      })
    );
  }

  console.log("[toast-crosswalk] manual match confirmed", {
    actor: user.id,
    toast_employee_guid: guid,
    employee_id: employeeId,
    location_id: punchLocation,
  });
  revalidatePath(BACK);
  redirect(backWith({ confirmed: "1", code: emp.employee_code ?? "" }));
}

export async function undoToastMatchAction(formData: FormData) {
  const { role, user, supabase } = await getSessionRole();
  if (!user || role !== "system_admin") {
    console.warn("[toast-crosswalk] undo denied (tier)", {
      user_id: user?.id ?? null,
      role,
    });
    redirect("/dashboard");
  }

  const guid = String(formData.get("toast_employee_guid") ?? "").trim();
  if (!guid) {
    redirect(backWith({ error: "Undo needs a Toast employee guid." }));
  }

  const { data: row, error: readErr } = await supabase
    .from("toast_employee_crosswalk")
    .select("toast_employee_guid, employee_id, match_method")
    .eq("toast_employee_guid", guid)
    .maybeSingle();
  if (readErr) {
    redirect(backWith({ error: `Undo failed: ${readErr.message}` }));
  }
  if (!row) {
    // Already undone — calm idempotency.
    redirect(backWith({ undone: "1" }));
  }

  // De-attribute BEFORE deleting the row (Codex 2026-08-23): whichever half
  // a race or failure strands, the nightly reconcileAttributions pass
  // re-aligns punches with whatever crosswalk rows exist — both orders
  // self-heal, but this one never leaves an attributed punch pointing at a
  // mapping that's already gone.
  try {
    await deattributeStoredPunches(supabase, guid);
  } catch (err) {
    redirect(
      backWith({
        error: `Undo failed before any change was made: ${err instanceof Error ? err.message : String(err)}`,
      })
    );
  }
  const { error: delErr } = await supabase
    .from("toast_employee_crosswalk")
    .delete()
    .eq("toast_employee_guid", guid);
  if (delErr) {
    redirect(
      backWith({
        error: `Punches de-attributed but the mapping row remains (the nightly re-attributes it): ${delErr.message}`,
      })
    );
  }

  console.log("[toast-crosswalk] match undone", {
    actor: user.id,
    toast_employee_guid: guid,
    was_method: row.match_method,
    was_employee_id: row.employee_id,
  });
  revalidatePath(BACK);
  redirect(backWith({ undone: "1" }));
}

/**
 * Archive / unarchive from the triage surface (spec 2026-08-25 §2, Tucker's
 * request): departed people holding open queue entries or reverse-check
 * rows. Sets active=false + stamps archived_at — NOTHING is deleted, and
 * schedule rows are never pruned (Eland Tell's 3 shifts are 7shifts' real
 * record and CP's departure-detector case; archiving is EPD's roster fact,
 * the schedule is the vendor's record — never falsify one to tidy the
 * other).
 *
 * ⚠️ THE CONSEQUENCE IS NAMED, NOT SILENT: archiving removes the
 * employee's rows from v_employee_scores and therefore from CP's and THQ's
 * feeds (the deactivation tombstone that will make that visible to THQ is
 * queued behind their paging fix — spec §3). The form carries an explicit
 * confirm field; the action refuses without it.
 */
export async function archiveEmployeeAction(formData: FormData) {
  const { role, user, supabase } = await getSessionRole();
  if (!user || role !== "system_admin") {
    console.warn("[toast-crosswalk] archive denied (tier)", {
      user_id: user?.id ?? null,
      role,
    });
    redirect("/dashboard");
  }

  const employeeId = String(formData.get("employee_id") ?? "").trim();
  const confirmed = formData.get("confirm_feed_consequence") === "1";
  if (!employeeId) {
    redirect(backWith({ error: "Archive: no employee selected." }));
  }
  if (!confirmed) {
    redirect(
      backWith({
        error:
          "Archive requires confirming the feed consequence — this removes the employee from CP's and THQ's score feeds.",
      })
    );
  }

  const { data: emp, error: empErr } = await supabase
    .from("employees")
    .select("id, employee_code, active")
    .eq("id", employeeId)
    .maybeSingle();
  if (empErr || !emp) {
    redirect(backWith({ error: `Archive: employee lookup failed.` }));
  }
  if (emp.active === false) {
    redirect(backWith({ already: "1", code: String(emp.employee_code) }));
  }

  const { error } = await supabase
    .from("employees")
    .update({ active: false, archived_at: new Date().toISOString() })
    .eq("id", employeeId);
  if (error) {
    redirect(backWith({ error: `Archive failed: ${error.message}` }));
  }

  revalidatePaths(employeeId);
  redirect(
    backWith({ archived: "1", code: String(emp.employee_code), emp: employeeId })
  );
}

/** Undo for a just-archived employee — the undoToastMatchAction doctrine. */
export async function unarchiveEmployeeAction(formData: FormData) {
  const { role, user, supabase } = await getSessionRole();
  if (!user || role !== "system_admin") {
    console.warn("[toast-crosswalk] unarchive denied (tier)", {
      user_id: user?.id ?? null,
      role,
    });
    redirect("/dashboard");
  }

  const employeeId = String(formData.get("employee_id") ?? "").trim();
  if (!employeeId) {
    redirect(backWith({ error: "Unarchive: no employee selected." }));
  }

  const { data: emp, error: empErr } = await supabase
    .from("employees")
    .select("employee_code")
    .eq("id", employeeId)
    .maybeSingle();
  if (empErr || !emp) {
    // Mirrors the archive path's guard (Codex 2026-08-25): a stale or
    // wrong id must not redirect as success after a zero-row update.
    redirect(backWith({ error: "Unarchive: employee lookup failed." }));
  }

  const { error } = await supabase
    .from("employees")
    .update({ active: true, archived_at: null })
    .eq("id", employeeId);
  if (error) {
    redirect(backWith({ error: `Unarchive failed: ${error.message}` }));
  }

  revalidatePaths(employeeId);
  redirect(backWith({ unarchived: "1", code: String(emp.employee_code) }));
}
