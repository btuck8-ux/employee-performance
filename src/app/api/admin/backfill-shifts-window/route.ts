import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCrosswalk } from "@/lib/ingest/sevenshifts/crosswalk";
import { ingestSevenShiftsShifts } from "@/lib/ingest/sevenshifts/shifts";
import { isValidIsoDate } from "@/lib/range-feed";

/**
 * §3f — historical shifts-window backfill (Q2 punch-recovery spec REVISED 2,
 * 2026-08-25). GET /api/admin/backfill-shifts-window?since=&until=
 *
 * WHY: seven_shifts_shifts reaches back only to 2026-06-01 (ingested
 * 2026-08-24, ~90-day lookback). April–May 2026 hold roughly half of Q2's
 * gap days and have NO shift-level attendance flag. Extending the window is
 * one parameter on an existing, working code path — and June already
 * produced 11 late/none convictions (§3e), so April–May stand to gain the
 * same class of evidence before any API probe runs.
 *
 * IF IT RETURNS NOTHING for April–May, that is itself the most valuable
 * single result in the packet: 7shifts' own retention window is then the
 * boundary, which answers why the punches cannot be fetched either. Rows
 * per month are reported EITHER WAY — including zero, explicitly (§9:
 * state the window, the source and the filter behind every "there is no
 * data for X").
 *
 * ⚠️ DENOMINATOR COUPLING — read before running. flip-entries' scheduled
 * source is DAY-CONDITIONAL on this table's coverage: a store-day that
 * gains direct-feed rows switches its scheduled source from time_entries
 * to the pruned feed at the NEXT recompute (and on live-compute surfaces).
 * Stored Q2 performance_records do not move — §7's ruling holds; the one
 * Q2 recompute happens after the ledger closes, by which point schedule
 * and punch history land together (§3c's one-operation rule). The response
 * reports how many store-days would switch source so the consequence is
 * measured, not discovered.
 *
 * AUTH: Bearer <CRON_SECRET>. Explicit window required — no defaults; the
 * §3f run is since=2026-04-01&until=2026-05-31.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const since = (url.searchParams.get("since") ?? "").trim();
  const until = (url.searchParams.get("until") ?? "").trim();
  if (!isValidIsoDate(since) || !isValidIsoDate(until)) {
    return NextResponse.json(
      { error: "since and until are required as calendar-valid YYYY-MM-DD — no defaults on a historical backfill" },
      { status: 400 }
    );
  }
  if (since > until) {
    return NextResponse.json(
      { error: `since (${since}) must not be after until (${until})` },
      { status: 400 }
    );
  }

  try {
    const supabase = createAdminClient();
    const crosswalk = await loadCrosswalk(supabase);

    // Store-days already covered BEFORE the pull — the source-switch delta
    // is measured against this.
    const coveredBefore = await coveredStoreDays(supabase, since, until);

    const outcomes = await ingestSevenShiftsShifts(supabase, crosswalk, {
      window: { since, until },
    });

    const coveredAfter = await coveredStoreDays(supabase, since, until);

    // Rows per month per store — zeros stated explicitly, never omitted.
    const months = monthsIn(since, until);
    const perStore: Record<string, Record<string, number>> = {};
    for (const loc of crosswalk) {
      const monthCounts: Record<string, number> = {};
      for (const m of months) monthCounts[m] = 0;
      perStore[loc.location_code] = monthCounts;
    }
    {
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("seven_shifts_shifts")
          .select("location_id, entry_date")
          .gte("entry_date", since)
          .lte("entry_date", until)
          .order("seven_shifts_shift_id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`row-count read: ${error.message}`);
        for (const r of data ?? []) {
          const code = crosswalk.find((l) => l.id === String(r.location_id))?.location_code;
          if (!code) continue;
          const m = String(r.entry_date).slice(0, 7);
          if (perStore[code] && m in perStore[code]) perStore[code][m] += 1;
        }
        if (!data || data.length < PAGE) break;
      }
    }

    return NextResponse.json({
      backfill: "shifts-window",
      window: { since, until },
      source: "7shifts GET /shifts, start[gte]/start[lte], filtered to crosswalked locations",
      rows_per_store_per_month: perStore,
      outcomes: outcomes.map((o) => ({
        location_code: o.location_code,
        status: o.status,
        rows_in: o.rows_in,
        rows_upserted: o.rows_upserted,
        error_text: o.error_text,
        detail: o.detail,
      })),
      denominator_coupling: {
        store_days_direct_covered_before: coveredBefore,
        store_days_direct_covered_after: coveredAfter,
        note:
          "store-days gaining direct-feed coverage switch their scheduled source from time_entries to the pruned feed at the NEXT recompute (flip-entries day-conditional rule). Stored Q2 rows do not move until the ledger-complete recompute (§7).",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[backfill-shifts-window] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Distinct (location, entry_date) pairs with live direct-feed rows in the
 * window — the flip's day-conditional coverage measure. */
async function coveredStoreDays(
  supabase: ReturnType<typeof createAdminClient>,
  since: string,
  until: string
): Promise<number> {
  const seen = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("seven_shifts_shifts")
      .select("location_id, entry_date")
      .gte("entry_date", since)
      .lte("entry_date", until)
      .is("missing_upstream_since", null)
      .order("seven_shifts_shift_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`coverage read: ${error.message}`);
    for (const r of data ?? []) {
      seen.add(`${r.location_id}|${String(r.entry_date).slice(0, 10)}`);
    }
    if (!data || data.length < PAGE) break;
  }
  return seen.size;
}

/** YYYY-MM list covering [since, until]. */
function monthsIn(since: string, until: string): string[] {
  const out: string[] = [];
  const d = new Date(`${since.slice(0, 7)}-01T12:00:00Z`);
  const end = until.slice(0, 7);
  for (;;) {
    const m = d.toISOString().slice(0, 7);
    out.push(m);
    if (m >= end) break;
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}
