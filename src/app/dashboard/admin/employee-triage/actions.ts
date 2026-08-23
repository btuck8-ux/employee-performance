"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import { createCpClient } from "@/lib/ingest/culture-pulse/client";
import {
  normalizeSevenShiftsUserId,
  resolveDetectionLocation,
} from "@/lib/triage/detections";

/**
 * Confirm-mint + dismiss for the detected-employee triage page
 * (kickoff-employee-triage-mint-ui-2026-08-21.md §3c/§3d).
 *
 * Both actions are system_admin-only and re-check server-side (server actions
 * are directly POSTable — the page gate alone stops nothing). Writes ride the
 * AUTHENTICATED client on purpose: employees/detection_dismissals writes are
 * SA-only under RLS (047/052), so the policy layer enforces what the code
 * checks — never the service role here.
 *
 * Mint idempotency is keyed on (seven_shifts_user_id, location_id) — the
 * multi-location identity (2026-08-23 sprint §4-A2). The pre-check reads the
 * pair, and mig 030's partial unique index on exactly that pair catches the
 * same-store double-submit race; both paths land on the calm "already minted
 * at this site" banner, never a duplicate person. A person already rostered
 * at ANOTHER store is a genuine second-site mint, not a duplicate — the six
 * live two-site people are two rows each by design. employee_code is NEVER
 * set here — the employee_code_seq default owns it (mig 004). hire_date
 * stays null — the §6-B nightly backfill owns it.
 */

const BACK = "/dashboard/admin/employee-triage";

function backWith(params: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  return `${BACK}?${p.toString()}`;
}

function trimmedOrNull(v: FormDataEntryValue | null, cap: number): string | null {
  const s = String(v ?? "").trim().slice(0, cap);
  return s ? s : null;
}

export async function confirmDetectionAction(formData: FormData) {
  const { role, user, supabase } = await getSessionRole();
  if (!user || role !== "system_admin") {
    console.warn("[triage] mint denied (tier)", {
      user_id: user?.id ?? null,
      role,
    });
    redirect("/dashboard");
  }

  const ssid = normalizeSevenShiftsUserId(
    String(formData.get("seven_shifts_user_id") ?? "")
  );
  const cpRowId = trimmedOrNull(formData.get("cp_id"), 60);
  const name = trimmedOrNull(formData.get("employee_name"), 120);
  const email = trimmedOrNull(formData.get("email"), 254);
  const phone = trimmedOrNull(formData.get("phone"), 40);
  // Wage rides along from the reviewed card (§5-A enrichment): what the
  // admin saw and approved is exactly what's written — deliberately NOT
  // re-fetched at confirm, where a 7shifts flake would silently drop it.
  const rawWage = String(formData.get("wage") ?? "").trim();
  const wageNum = rawWage ? Number(rawWage) : NaN;
  const wage = Number.isFinite(wageNum) && wageNum > 0 ? wageNum : null;
  const wagePayType = wage !== null ? trimmedOrNull(formData.get("wage_pay_type"), 40) : null;

  // ssid > 0: 0 is the known 7shifts phantom class — dismissable, never
  // mintable.
  if (ssid === null || ssid <= 0 || !name || !cpRowId) {
    redirect(
      backWith({
        error: "Mint needs a name, a real 7shifts user id, and its CP row.",
      })
    );
  }

  // The site is re-derived server-side from CP + the crosswalk (Codex
  // finding 2, 2026-08-21) — location is display-only on the card and never
  // client input. The CP row id + 7s id must match the same pending row
  // (Codex finding 2, 2026-08-23 — see resolveDetectionLocation).
  let location: { id: string; name: string } | null = null;
  let resolveFailure: string | null = null;
  try {
    location = await resolveDetectionLocation(
      createCpClient(),
      supabase,
      ssid,
      cpRowId
    );
  } catch (err) {
    resolveFailure = err instanceof Error ? err.message : String(err);
  }
  if (resolveFailure) {
    redirect(backWith({ error: `Mint failed: ${resolveFailure}` }));
  }
  if (!location) {
    redirect(
      backWith({
        error:
          "This detection is no longer pending in CP (or its site isn't crosswalked) — refresh and re-check.",
      })
    );
  }
  const locationId = location.id;

  // Idempotency guard — on the (7s id, location) pair, matching mig 030's
  // partial unique index exactly (§4-A2). A row at another store must NOT
  // trip this: that person picking up shifts here is a legitimate
  // second-site mint.
  const { data: existing, error: guardError } = await supabase
    .from("employees")
    .select("employee_code, employee_name")
    .eq("seven_shifts_user_id", ssid)
    .eq("location_id", locationId)
    .limit(1)
    .maybeSingle();
  if (guardError) {
    redirect(backWith({ error: `Mint pre-check failed: ${guardError.message}` }));
  }
  if (existing) {
    redirect(
      backWith({
        already: "1",
        name: existing.employee_name ?? name,
        code: existing.employee_code ?? "",
        site: location.name,
      })
    );
  }

  const insertRow: Record<string, unknown> = {
    location_id: locationId,
    employee_name: name,
    email,
    phone,
    seven_shifts_user_id: ssid,
  };
  if (wage !== null) {
    insertRow.wage = wage;
    insertRow.wage_pay_type = wagePayType;
  }

  const { data: minted, error: insertError } = await supabase
    .from("employees")
    .insert(insertRow)
    .select("employee_code")
    .single();
  if (insertError || !minted) {
    // 23505 = the mig-030 partial unique index fired on a double-submit race
    // — the row exists now; report it calmly, not as an error. The re-read
    // is pair-keyed like the pre-check (§4-A2): a location-less read here
    // would report a DIFFERENT store's code as "already minted".
    if (insertError?.code === "23505") {
      const { data: raced } = await supabase
        .from("employees")
        .select("employee_code")
        .eq("seven_shifts_user_id", ssid)
        .eq("location_id", locationId)
        .limit(1)
        .maybeSingle();
      redirect(
        backWith({
          already: "1",
          name,
          code: raced?.employee_code ?? "",
          site: location.name,
        })
      );
    }
    redirect(
      backWith({
        error: `Mint failed: ${insertError?.message ?? "no row returned"}`,
      })
    );
  }

  console.log("[triage] employee minted", {
    actor: user.id,
    employee_code: minted.employee_code,
    seven_shifts_user_id: ssid,
    location_id: locationId,
  });

  revalidatePath(BACK);
  revalidatePath("/dashboard/employees");
  redirect(
    backWith({ minted: "1", name, code: minted.employee_code, site: location.name })
  );
}

export async function dismissDetectionAction(formData: FormData) {
  const { role, user, supabase } = await getSessionRole();
  if (!user || role !== "system_admin") {
    console.warn("[triage] dismiss denied (tier)", {
      user_id: user?.id ?? null,
      role,
    });
    redirect("/dashboard");
  }

  const ssid = normalizeSevenShiftsUserId(
    String(formData.get("seven_shifts_user_id") ?? "")
  );
  const cpRowId = trimmedOrNull(formData.get("cp_id"), 60);
  const name = trimmedOrNull(formData.get("employee_name"), 120) ?? "detection";
  // ssid >= 0: the "7shifts user 0" phantom is exactly what dismiss is for.
  if (ssid === null || ssid < 0 || !cpRowId) {
    redirect(
      backWith({ error: "Dismiss needs a usable 7shifts user id and its CP row." })
    );
  }

  // Dismissals are per-site since mig 053 (§4-A3), and the site is re-derived
  // server-side exactly like the mint path (Codex finding 2 doctrine:
  // location is never client input; the CP row id + 7s id must match the
  // same pending row).
  let location: { id: string; name: string } | null = null;
  let resolveFailure: string | null = null;
  try {
    location = await resolveDetectionLocation(
      createCpClient(),
      supabase,
      ssid,
      cpRowId
    );
  } catch (err) {
    resolveFailure = err instanceof Error ? err.message : String(err);
  }
  if (resolveFailure) {
    redirect(backWith({ error: `Dismiss failed: ${resolveFailure}` }));
  }
  if (!location) {
    redirect(
      backWith({
        error:
          "This detection is no longer pending in CP (or its site isn't crosswalked) — refresh and re-check.",
      })
    );
  }

  // Re-dismissing at the same site is a no-op, not an error (same
  // calm-idempotency stance as the mint guard).
  const { error } = await supabase.from("detection_dismissals").upsert(
    {
      seven_shifts_user_id: ssid,
      location_id: location.id,
      dismissed_by: user.id,
    },
    { onConflict: "seven_shifts_user_id,location_id", ignoreDuplicates: true }
  );
  if (error) {
    redirect(backWith({ error: `Dismiss failed: ${error.message}` }));
  }

  console.log("[triage] detection dismissed", {
    actor: user.id,
    seven_shifts_user_id: ssid,
    location_id: location.id,
  });

  revalidatePath(BACK);
  revalidatePath("/dashboard/employees");
  redirect(backWith({ dismissed: "1", name, site: location.name }));
}
