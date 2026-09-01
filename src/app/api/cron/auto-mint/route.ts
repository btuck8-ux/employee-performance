import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { sendFatalAlert } from "@/lib/ingest/sevenshifts/alert";
import { runAutoMint } from "@/lib/identity/auto-mint-orchestrator";

/**
 * Nightly auto-mint (2026-08-31 identity packet §3).
 *
 * Gives an EPD employee_code to people CP is already scheduling, with no human
 * in the loop, capped at BLAST_RADIUS_CAP candidates per run. Everything else
 * — cross-store holds, archived matches, cap trips, uncrosswalked locations,
 * epd_role, GM designation — is reported, never resolved.
 *
 * ONE CODE PER HUMAN (Tucker, 2026-08-31): only a 7shifts id that exists at NO
 * store is minted. Someone already coded elsewhere is held and reported.
 *
 * ⚠️ SCHEDULE: this ships on the CURRENT ordering and must run clean for TWO
 * consecutive nights before Phase 4 touches any cron. Do not land the cron
 * reorder in the same PR — if both change at once a failure cannot be
 * attributed to either.
 *
 * Proxy-exempt under /api/cron/*; this handler enforces its own
 * Authorization: Bearer <CRON_SECRET>, which Vercel Cron forwards.
 */

export const dynamic = "force-dynamic";
// One estate-wide CP read plus at most BLAST_RADIUS_CAP single-row inserts.
export const maxDuration = 120;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  try {
    const summary = await runAutoMint();
    console.log(
      `[auto-mint] done: ${summary.minted.length} minted of ${summary.candidates_seen} candidate(s)` +
        (summary.blast_radius_tripped ? " — BLAST RADIUS TRIPPED, minted nothing" : ""),
      {
        cross_store_held: summary.cross_store_held.length,
        archived_new: summary.archived_new.length,
        unmappable: summary.unmappable.length,
        guard_rejected: summary.guard_rejected,
      }
    );
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[auto-mint] fatal:", message);
    // A fatal before/inside startRun leaves no ingest_runs row for the
    // run-outcome alert to notice (the 2026-08-14 blind-spot). Alert from the
    // catch itself; sendFatalAlert never throws.
    await sendFatalAlert("/api/cron/auto-mint", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
