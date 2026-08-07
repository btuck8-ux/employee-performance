import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCrosswalk } from "@/lib/ingest/sevenshifts/crosswalk";
import { startRun, finishRun } from "@/lib/ingest/sevenshifts/runs";
import { ingestTimePunches } from "@/lib/ingest/sevenshifts/time";
import { resolveIdentities } from "@/lib/ingest/sevenshifts/identities";
import {
  quarterWorkedCoverage,
  quarterCoverageWindow,
} from "@/lib/ingest/sevenshifts/coverage";
import { currentQuarter } from "@/lib/quarter";

/**
 * Stage 2 — one-shot WORKED-TIME backfill for a single 7shifts location.
 *
 * WHY: when the Phase 11 nightly cron came up mid-quarter, every 7shifts store
 * was left with a pre-cron hole (HOU had 2 of 31 May days; CO stores ~9-10 of
 * ~26). The firstRunFloor guard prevents this going forward but cannot heal a
 * hole already behind a location's high-water mark — that needs a backfill that
 * deliberately re-pulls from the quarter start. Houston was healed by hand; this
 * route is the durable, repeatable version for the other six stores.
 *
 * SCOPE — TIME ONLY. This reuses ingestTimePunches(), which lands worked
 * time_entries AND triggers the same per-(employee × quarter) recompute the time
 * CSV importer does (time.ts). That alone correctly restores the time-based
 * metrics: attendance, on-time, hours, and presence-based tip.
 *
 * It does NOT touch guest feedback. The other stores' Tattle / Reviews / Tasks /
 * Survey are themselves stale (current only ~through early May) and their
 * attribution was computed against holey time, so it is wrong. Fixing that needs
 * a fresh export + re-import per store — the full Houston flow ×6 — which is
 * exactly what handoff §1 (CP survey feed) and §2 (Tattle harvester) automate.
 *
 *   ⇒ After this backfill a store's TIME-BASED metrics are correct, but its
 *     guest-feedback / survey metrics stay STALE until re-pulled. That re-pull
 *     should wait for §1/§2 to be live (automated) — NOT 6× manual CIC. Do not
 *     bolt feedback re-imports onto this route.
 *
 * SHAPE: one location per invocation (observed, gated), idempotent (time_entries
 * upsert on (employee, date, type); recompute is deterministic). It records an
 * ingest_runs row (source 7shifts_time) whose wide window_start marks it as a
 * backfill, and returns before/after worked-day coverage for that store so the
 * operator can verify the hole closed before moving to the next.
 *
 * WINDOW SEMANTICS: ingestTimePunches pulls via `modified_since = windowStart`
 * (not a punch-date range). A quarter-start windowStart therefore re-fetches
 * every punch modified since the quarter began, which in practice covers the
 * quarter's worked days (punches finalize at clock-out within the quarter). An
 * optional `since=YYYY-MM-DD` override widens/narrows that floor when needed.
 *
 * AUTH: Bearer <CRON_SECRET>, mirroring the nightly cron route. Invoke per store:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "$BASE/api/admin/backfill-worked-time?location=COS"
 */

export const dynamic = "force-dynamic";
// A quarter-wide modified_since window for one location; give it room under the
// Vercel function ceiling (single store, so well within 300s).
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const locationParam = (url.searchParams.get("location") ?? "").trim();
  const sinceParam = (url.searchParams.get("since") ?? "").trim();
  if (!locationParam) {
    return NextResponse.json(
      { error: "Missing ?location=<location_code> (one location per invocation)" },
      { status: 400 }
    );
  }

  try {
    const supabase = createAdminClient();
    const crosswalk = await loadCrosswalk(supabase);
    const loc = crosswalk.find(
      (l) => l.location_code.toLowerCase() === locationParam.toLowerCase()
    );

    if (!loc) {
      return NextResponse.json(
        {
          error: `Unknown location_code "${locationParam}"`,
          known: crosswalk.map((l) => l.location_code),
        },
        { status: 404 }
      );
    }
    if (loc.actuals_source !== "7shifts") {
      // CAKE-sourced stores (NOLA) have no 7shifts time pull to backfill.
      return NextResponse.json(
        {
          error: `${loc.location_code} actuals_source is "${loc.actuals_source}", not 7shifts — nothing to backfill here.`,
        },
        { status: 400 }
      );
    }

    // Window: default to the current quarter start; allow an explicit floor.
    const windowStart = sinceParam
      ? `${sinceParam}T00:00:00.000Z`
      : currentQuarter().periodStart.toISOString();
    const windowEnd = new Date().toISOString();

    // Resolve this location's 7shifts identities first (idempotent email bridge)
    // so punches join to employees by seven_shifts_user_id, exactly as nightly.
    const identities = await resolveIdentities(supabase, [loc]);

    const coverageWindow = quarterCoverageWindow(currentQuarter(), new Date());
    const coverageBefore = await quarterWorkedCoverage(supabase, [loc], coverageWindow);

    const runId = await startRun(supabase, "7shifts_time", loc.id, windowStart, windowEnd);
    const outcome = await ingestTimePunches(supabase, loc, windowStart, windowEnd);
    await finishRun(supabase, runId, outcome);

    const coverageAfter = await quarterWorkedCoverage(supabase, [loc], coverageWindow);

    return NextResponse.json({
      backfill: "worked-time",
      location_code: loc.location_code,
      window: { start: windowStart, end: windowEnd },
      identities,
      outcome: {
        status: outcome.status,
        rows_in: outcome.rows_in,
        rows_upserted: outcome.rows_upserted,
        rows_skipped: outcome.rows_skipped,
        error_text: outcome.error_text,
        detail: outcome.detail,
      },
      coverage_before: coverageBefore[0] ?? null,
      coverage_after: coverageAfter[0] ?? null,
      note: "TIME ONLY — guest-feedback/survey metrics remain stale until §1/§2 re-pull (do not re-import feedback here).",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[backfill-worked-time] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
