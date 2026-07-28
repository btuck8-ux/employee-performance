import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCrosswalk, type LocationCrosswalk, type AdminClient } from "@/lib/ingest/sevenshifts/crosswalk";
import { getAll } from "@/lib/ingest/sevenshifts/client";
import { rolesForCompany } from "@/lib/ingest/sevenshifts/roles";
import {
  collapsePunches,
  employeeMapForLocation,
  type TimePunch,
} from "@/lib/ingest/sevenshifts/time";
import { timezoneForLocationCode } from "@/lib/ingest/sevenshifts/tz";

/**
 * ROLE-ONLY backfill for time_entries (handoff 2026-07-28 §3.3).
 *
 * WHY: the Phase 11 nightly hardcoded `role: null` from mid-April on, and its
 * upsert on (employee, date, type) overwrote the CSV-era roles night after
 * night — last 60 days show 0 roles at all 7 non-NOLA stores. The punch data
 * still carries role_id, so the roles are fully recoverable from 7shifts.
 *
 * SCOPE — ROLE COLUMN ONLY. Re-pulls punches, collapses them with the exact
 * same shared collapsePunches() the nightly uses (dominant role per day), and
 * UPDATEs only `role` on existing rows. Hours/pay/in/out are never touched, so
 * this can never disturb verified attendance or tip math. Rows whose resolved
 * role is null are SKIPPED (writing null is at best a no-op, at worst the
 * regression again). Missing target rows are counted, never inserted.
 *
 * AUTH: Bearer <CRON_SECRET>. One store or all 7shifts stores:
 *   GET /api/admin/backfill-roles?location=<CODE|all>&since=2026-04-01
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_SINCE = "2026-04-01"; // where the role decay starts (handoff §0)

const UPDATE_CONCURRENCY = 10;

interface StoreResult {
  location_code: string;
  punches_fetched: number;
  collapsed_days: number;
  updated: number;
  not_found: number;
  skipped_no_role: number;
  multi_role_days: number;
  unmatched_seven_shifts_user_ids: number[];
  unmapped_role_ids: number[];
  roles_written: Record<string, number>;
  error?: string;
}

async function backfillStore(
  supabase: AdminClient,
  loc: LocationCrosswalk,
  sinceIso: string
): Promise<StoreResult> {
  const result: StoreResult = {
    location_code: loc.location_code,
    punches_fetched: 0,
    collapsed_days: 0,
    updated: 0,
    not_found: 0,
    skipped_no_role: 0,
    multi_role_days: 0,
    unmatched_seven_shifts_user_ids: [],
    unmapped_role_ids: [],
    roles_written: {},
  };

  const tz = timezoneForLocationCode(loc.location_code);
  const userToEmployee = await employeeMapForLocation(supabase, loc.id);
  // Backfill is a deliberate repair — a failed roles lookup is a hard error
  // here, not a degrade (there is nothing to do without the name map).
  const roleNames = await rolesForCompany(loc.company_id);

  const punches = await getAll<TimePunch>(loc.company_id, "time_punches", {
    location_id: loc.seven_shifts_location_id,
    modified_since: sinceIso,
    limit: 100,
  });
  result.punches_fetched = punches.length;

  const collapse = collapsePunches(punches, userToEmployee, tz);
  result.collapsed_days = collapse.entries.length;
  result.multi_role_days = collapse.multiRoleDays;
  result.unmatched_seven_shifts_user_ids = collapse.unmatchedUserIds;

  const unmapped = new Set<number>();
  const updates: Array<{ employee_id: string; entry_date: string; role: string }> = [];
  for (const c of collapse.entries) {
    if (c.role_id == null) {
      result.skipped_no_role += 1;
      continue;
    }
    const role = roleNames.get(c.role_id);
    if (!role) {
      unmapped.add(c.role_id);
      result.skipped_no_role += 1;
      continue;
    }
    updates.push({ employee_id: c.employee_id, entry_date: c.entry_date, role });
  }
  result.unmapped_role_ids = Array.from(unmapped);

  for (let i = 0; i < updates.length; i += UPDATE_CONCURRENCY) {
    const chunk = updates.slice(i, i + UPDATE_CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map(async (u) => {
        const { data, error } = await supabase
          .from("time_entries")
          .update({ role: u.role })
          .eq("employee_id", u.employee_id)
          .eq("entry_date", u.entry_date)
          .eq("entry_type", "worked")
          .select("id");
        if (error) throw new Error(`role update ${u.entry_date}: ${error.message}`);
        return { role: u.role, matched: (data ?? []).length > 0 };
      })
    );
    for (const o of outcomes) {
      if (o.matched) {
        result.updated += 1;
        result.roles_written[o.role] = (result.roles_written[o.role] ?? 0) + 1;
      } else {
        result.not_found += 1;
      }
    }
  }

  return result;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if ((request.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const locationParam = (url.searchParams.get("location") ?? "").trim();
  const sinceParam = (url.searchParams.get("since") ?? DEFAULT_SINCE).trim();
  if (!locationParam) {
    return NextResponse.json(
      { error: "Missing ?location=<location_code|all>" },
      { status: 400 }
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceParam)) {
    return NextResponse.json({ error: "?since= must be YYYY-MM-DD" }, { status: 400 });
  }
  const sinceIso = `${sinceParam}T00:00:00.000Z`;

  try {
    const supabase = createAdminClient();
    const crosswalk = await loadCrosswalk(supabase);
    // NOLA (CAKE actuals) writes role on its own path and is untouched here.
    const sevenShiftsLocs = crosswalk.filter((l) => l.actuals_source === "7shifts");

    const targets =
      locationParam.toLowerCase() === "all"
        ? sevenShiftsLocs
        : sevenShiftsLocs.filter(
            (l) => l.location_code.toLowerCase() === locationParam.toLowerCase()
          );
    if (targets.length === 0) {
      return NextResponse.json(
        {
          error: `No 7shifts-sourced location matches "${locationParam}"`,
          known: sevenShiftsLocs.map((l) => l.location_code),
        },
        { status: 404 }
      );
    }

    const stores: StoreResult[] = [];
    for (const loc of targets) {
      try {
        stores.push(await backfillStore(supabase, loc, sinceIso));
      } catch (err) {
        stores.push({
          location_code: loc.location_code,
          punches_fetched: 0,
          collapsed_days: 0,
          updated: 0,
          not_found: 0,
          skipped_no_role: 0,
          multi_role_days: 0,
          unmatched_seven_shifts_user_ids: [],
          unmapped_role_ids: [],
          roles_written: {},
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return NextResponse.json({
      backfill: "time-entry-roles",
      since: sinceParam,
      note: "ROLE column only — hours/pay/in/out untouched; null-role days skipped; no rows inserted.",
      stores,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[backfill-roles] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
