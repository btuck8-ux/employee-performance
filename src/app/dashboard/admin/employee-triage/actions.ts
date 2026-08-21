"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionRole } from "@/lib/authz";
import { normalizeSevenShiftsUserId } from "@/lib/triage/detections";

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
 * Mint idempotency (§2 ⚠️): there is NO global unique constraint on
 * employees.seven_shifts_user_id (only the partial unique index on
 * (location_id, seven_shifts_user_id), mig 030) — the guard is a global
 * pre-check on seven_shifts_user_id, with the index catching the same-store
 * double-submit race; both paths land on the calm "already minted" banner,
 * never a duplicate person. employee_code is NEVER set here — the
 * employee_code_seq default owns it (mig 004). hire_date stays null — the
 * §6-B nightly backfill owns it.
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
  const locationId = String(formData.get("location_id") ?? "").trim();
  const name = trimmedOrNull(formData.get("employee_name"), 120);
  const email = trimmedOrNull(formData.get("email"), 254);
  const phone = trimmedOrNull(formData.get("phone"), 40);
  // Wage rides along from the 7shifts enrichment (§5-A) when present.
  const rawWage = String(formData.get("wage") ?? "").trim();
  const wageNum = rawWage ? Number(rawWage) : NaN;
  const wage = Number.isFinite(wageNum) && wageNum > 0 ? wageNum : null;
  const wagePayType = wage !== null ? trimmedOrNull(formData.get("wage_pay_type"), 40) : null;

  // ssid > 0: 0 is the known 7shifts phantom class — dismissable, never
  // mintable.
  if (ssid === null || ssid <= 0 || !locationId || !name) {
    redirect(
      backWith({
        error:
          "Mint needs a name, a crosswalked site, and a real 7shifts user id.",
      })
    );
  }

  // Idempotency guard — GLOBAL on seven_shifts_user_id, deliberately wider
  // than the per-location index, so a person re-detected at another store
  // still reads as already-minted.
  const { data: existing, error: guardError } = await supabase
    .from("employees")
    .select("employee_code, employee_name")
    .eq("seven_shifts_user_id", ssid)
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
    // — the row exists now; report it calmly, not as an error.
    if (insertError?.code === "23505") {
      const { data: raced } = await supabase
        .from("employees")
        .select("employee_code")
        .eq("seven_shifts_user_id", ssid)
        .limit(1)
        .maybeSingle();
      redirect(
        backWith({ already: "1", name, code: raced?.employee_code ?? "" })
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
  redirect(backWith({ minted: "1", name, code: minted.employee_code }));
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
  const name = trimmedOrNull(formData.get("employee_name"), 120) ?? "detection";
  // ssid >= 0: the "7shifts user 0" phantom is exactly what dismiss is for.
  if (ssid === null || ssid < 0) {
    redirect(
      backWith({ error: "Dismiss needs a usable 7shifts user id." })
    );
  }

  // Re-dismissing is a no-op, not an error (same calm-idempotency stance as
  // the mint guard).
  const { error } = await supabase.from("detection_dismissals").upsert(
    { seven_shifts_user_id: ssid, dismissed_by: user.id },
    { onConflict: "seven_shifts_user_id", ignoreDuplicates: true }
  );
  if (error) {
    redirect(backWith({ error: `Dismiss failed: ${error.message}` }));
  }

  console.log("[triage] detection dismissed", {
    actor: user.id,
    seven_shifts_user_id: ssid,
  });

  revalidatePath(BACK);
  revalidatePath("/dashboard/employees");
  redirect(backWith({ dismissed: "1", name }));
}
