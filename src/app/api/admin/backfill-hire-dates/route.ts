import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fillMissingHireDates } from "@/lib/hire-date-fill";

/**
 * Operator backfill for NULL employees.hire_date (kickoff 2026-08-17 §3,
 * Tucker §6-B ruling — see src/lib/hire-date-fill.ts for the full ruling
 * and the probe evidence that 7shifts has no hire date to give).
 *
 * FILL-NULLS-ONLY, never overwrites: employees with a hire_date keep it.
 * NULLs fill from the earliest WORKED time_entries row (scheduled rows
 * deliberately don't count). Idempotent — a second run finds nothing to do.
 *
 * The response lists every filled row (employee_code, name, date) so the
 * operator can eyeball what moved; employees with no worked history yet
 * stay NULL and are counted, not guessed.
 *
 * AUTH: Bearer <CRON_SECRET>, the standing operator-lever pattern:
 *   GET /api/admin/backfill-hire-dates
 */

export const dynamic = "force-dynamic";
// ~220-employee worst case at concurrency 8 — far under the ceiling, but
// keep the standard operator-route headroom.
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  try {
    const supabase = createAdminClient();
    const result = await fillMissingHireDates(supabase);
    console.log(
      `[backfill-hire-dates] examined ${result.examined} NULLs: filled ${result.filled}, no-worked ${result.no_worked_entries}, errors ${result.errors}`
    );
    return NextResponse.json({
      backfill: "hire-dates",
      note: "Fill-NULLs-only from earliest WORKED time entry (Tucker §6-B ruling 2026-08-17). Existing hire dates are never touched; scheduled entries don't count. Idempotent.",
      ...result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[backfill-hire-dates] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
