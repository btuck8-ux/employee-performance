import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { sendFatalAlert } from "@/lib/ingest/sevenshifts/alert";
import { runNightlyIngest } from "@/lib/ingest/sevenshifts/orchestrator";
import { createAdminClient } from "@/lib/supabase/admin";
import { fillMissingHireDates } from "@/lib/hire-date-fill";

/**
 * Nightly 7shifts auto-ingest (Phase 11).
 *
 * Fans out the 7shifts trio — time punches, 7tasks summary, POS receipts —
 * across all wired locations, landing rows through the same upsert + recompute
 * path as the manual CSV imports. One ingest_runs row per source x location.
 *
 * After the ingest, the hire-date NULL-fill runs (kickoff 2026-08-17 §3,
 * Tucker §6-B ruling): new hires whose first WORKED shift just landed get
 * employees.hire_date stamped the same night. Fill-NULLs-only — existing
 * dates are never touched; it reads time_entries regardless of source feed,
 * so NOLA's CAKE rows are covered by this same pass (they land ~13:30 UTC,
 * so a brand-new NOLA hire stamps on the NEXT night's cycle — accepted lag).
 * A fill failure logs but never fails the cron.
 *
 * Scheduled via vercel.json cron at 09:00 UTC (~2-3 AM Phoenix, after close +
 * POS sync). Proxy-exempt under /api/cron/* (see src/proxy.ts); this
 * handler enforces its own Authorization: Bearer <CRON_SECRET>, which Vercel
 * Cron forwards automatically.
 *
 * Returns the run summary JSON. Failures are also captured in ingest_runs and,
 * when configured, emailed (see alert.ts).
 */

export const dynamic = "force-dynamic";
// Fan-out + per-location recompute across 8 locations; give it room under the
// Vercel function ceiling.
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  try {
    const summary = await runNightlyIngest();
    console.log(
      `[nightly-ingest] done: ${summary.runs} runs across ${summary.locations} locations`,
      summary.by_status
    );

    // Hire-date NULL-fill rides the nightly but must never fail it — the
    // ingest itself is already durably recorded by this point.
    let hireDateFill: unknown;
    try {
      const fill = await fillMissingHireDates(createAdminClient());
      hireDateFill = fill;
      if (fill.filled > 0 || fill.errors > 0) {
        console.log(
          `[nightly-ingest] hire-date fill: examined ${fill.examined}, filled ${fill.filled}, no-worked ${fill.no_worked_entries}, errors ${fill.errors}`
        );
      }
    } catch (fillErr) {
      const m = fillErr instanceof Error ? fillErr.message : String(fillErr);
      console.error("[nightly-ingest] hire-date fill failed (non-fatal):", m);
      hireDateFill = { error: m };
    }

    return NextResponse.json({ ...summary, hire_date_fill: hireDateFill });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[nightly-ingest] fatal:", message);
    // A fatal here usually means the FIRST DB call died — zero ingest_runs
    // rows, so the run-outcome alert is blind to it (2026-08-14 outage).
    // Send the failure email from the catch itself; never throws.
    await sendFatalAlert("/api/cron/nightly-ingest", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
