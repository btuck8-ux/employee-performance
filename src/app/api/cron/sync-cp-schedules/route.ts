import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { sendFatalAlert } from "@/lib/ingest/sevenshifts/alert";
import { runCpScheduleSync } from "@/lib/ingest/culture-pulse/schedule-orchestrator";
import { runAutoMint } from "@/lib/identity/auto-mint-orchestrator";

/**
 * Nightly CP→EPD scheduled-shifts sync (kickoff-ui-rbac-c-brand-2026-08-14.md §3).
 *
 * Lands each store's Culture Pulse weekly_schedule_entries as
 * time_entries(entry_type='scheduled') — the rows attendance / on-time / TIS
 * score against — then recomputes the touched (employee × quarter) set. One
 * ingest_runs row per store (source 'cp_schedule', migration 049).
 *
 * Scheduled via vercel.json at 09:40 UTC — after the guest-feedback harvest
 * (09:30) and before cp-surveys (09:45), so worked time from nightly-ingest
 * (09:00) has landed before the recompute here reads scheduled-vs-worked.
 * Proxy-exempt under /api/cron/*; this handler enforces its own
 * Authorization: Bearer <CRON_SECRET>, which Vercel Cron forwards.
 *
 * A store's FIRST run backfills from 2026-06-01 (the scheduled-shifts gap),
 * so no separate backfill step exists — the first nightly is the backfill.
 *
 * AUTO-MINT RIDES THIS JOB (identity packet §3, mechanism (a), Tucker
 * 2026-08-31). Hanging it here rather than giving it its own cron entry is
 * what makes Phase 4 a pure TIMING change: moving this cron 09:40 → 10:30
 * moves auto-mint with it, and no new schedule is introduced in Phase 3.
 *
 * On the CURRENT 09:40 slot auto-mint runs BEFORE CP's ~10:00 ingest, so it
 * mints from the PREVIOUS day's discoveries — the ~23h floor Phase 4 exists to
 * remove. That is a latency property, not a correctness one: the job is
 * idempotent on (7shifts id, location), so the delay costs a day, never a
 * duplicate.
 *
 * It is deliberately NON-FATAL to the schedule sync: scheduled-shift rows feed
 * attendance and TIS, auto-mint only adds roster rows, so a minting failure
 * must never turn a good schedule night into a failed one. Its own errors
 * surface through its own ingest_runs row and its own fatal alert.
 */

export const dynamic = "force-dynamic";
// 8 stores × (a ~5-week CP window + per-employee recompute); the first-run
// backfill (Jun 1 → today+21d, ~1,600 rows/store max) is the worst case and
// still lands well under the ceiling.
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  try {
    const summary = await runCpScheduleSync();
    console.log(
      `[sync-cp-schedules] done: ${summary.runs} runs across ${summary.locations} locations`,
      summary.by_status
    );

    // Non-fatal by design — see the header note.
    let autoMint: unknown = null;
    try {
      // Env gate (2026-09-01): held until the cross-store guard is proven in
      // the Prompt 2 sprint. Unset means ON — only the literal "false" holds,
      // so a missing var can never silently disable minting. The manual
      // /api/cron/auto-mint route is deliberately NOT gated (observation
      // stays possible). The log line makes a held night distinguishable
      // from a night with no candidates.
      if (process.env.AUTO_MINT_ENABLED === "false") {
        console.log(
          "[sync-cp-schedules] auto-mint held: AUTO_MINT_ENABLED=false"
        );
        autoMint = { held: "AUTO_MINT_ENABLED=false" };
      } else {
        const mint = await runAutoMint();
        autoMint = {
          minted: mint.minted,
          candidates_seen: mint.candidates_seen,
          blast_radius_tripped: mint.blast_radius_tripped,
          cross_store_held: mint.cross_store_held.length,
          archived_new: mint.archived_new.length,
          unmappable: mint.unmappable.length,
        };
        console.log(
          `[sync-cp-schedules] auto-mint: ${mint.minted.length} minted of ${mint.candidates_seen} candidate(s)` +
            (mint.blast_radius_tripped ? " — BLAST RADIUS TRIPPED, minted nothing" : "")
        );
      }
    } catch (mintErr) {
      const message = mintErr instanceof Error ? mintErr.message : String(mintErr);
      console.error("[sync-cp-schedules] auto-mint failed (non-fatal):", message);
      autoMint = { error: message };
    }

    return NextResponse.json({ ...summary, auto_mint: autoMint });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sync-cp-schedules] fatal:", message);
    // A fatal here usually means the FIRST DB call died — zero ingest_runs
    // rows, so the run-outcome alert is blind to it (2026-08-14 outage).
    // Send the failure email from the catch itself; never throws.
    await sendFatalAlert("/api/cron/sync-cp-schedules", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
