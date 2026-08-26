import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { addDaysIso } from "@/lib/punch-days";

/**
 * §7b — departure-candidate report (Q2 punch-recovery spec REVISED 2,
 * 2026-08-25). GET /api/admin/departure-candidates. READ-ONLY — no writes,
 * ever, from this route.
 *
 * THE FINDING THIS SERVES: EPD has no departure signal. Exactly 2 of 218
 * employee rows have archived_at set; people stop punching and stay on the
 * books forever — and 7shifts keeps scheduling them, so every scheduled
 * day after a departure lands in the attendance denominator as a missed
 * shift. Four Q2 departures are Tucker-confirmed on exactly this shape
 * (§3d); Q3 has 145 exposed scheduled days across 28 employees, published
 * at 94%.
 *
 * THE RULE (computable, §7b): any employee whose latest scheduled date
 * exceeds their last punch ever by MORE THAN 14 DAYS is a candidate.
 * Employees with NO punch ever are excluded — that is the blind cohort
 * (§3d), a data question, not a departure question.
 *
 * These are CANDIDATES, NOT CONCLUSIONS. Tucker confirms; nobody acts on
 * this list unilaterally. Setting active/archived_at, changing any
 * denominator, and touching Q3 are all explicitly out of scope — this
 * defect gets its own packet (§7b: "the second defect this sprint found by
 * looking at the first one").
 *
 * Punch history: v_worked_intervals (the era-correct union of both punch
 * sources, §3b — never raw time_entries, §0's trap). Scheduled history:
 * time_entries scheduled ∪ the pruned direct feed.
 *
 * §1g GHOST-ROW FRESHNESS (demarcation packet 2026-08-26; found by
 * CulturePulse): time_entries has NO tombstone — when 7shifts stops
 * serving a scheduled shift, EPD's mirror keeps the row forever (Josiah
 * Ornelas: five rows the 08-25 nightly did not refresh, which CP had
 * independently pruned). A stale row proves nothing in either direction,
 * so RECENT/FUTURE schedule evidence here is freshness-tested: a
 * time_entries scheduled row dated within the nightly's refresh reach
 * (today − 14d onward) counts only if its updated_at >= the location's
 * last successful cp_schedule run — the nightly rewrites every
 * still-served row's updated_at each pass, so staleness against the last
 * successful run IS absence-from-upstream. That equivalence is why a
 * dedicated missing_upstream_since column on time_entries is not required
 * for THIS surface (documented + pinned per §1g); rows older than the
 * refresh reach are historical facts and are not freshness-tested. Stale
 * rows are never silently dropped: they are counted and reported per
 * candidate (stale_recent_scheduled_rows) — a ghost is a finding, not
 * noise. The direct feed needs none of this: seven_shifts_shifts carries
 * missing_upstream_since and is already pruned.
 *
 * AUTH: Bearer <CRON_SECRET>.
 *   GET /api/admin/departure-candidates
 *     ?threshold_days=14   optional override, default 14
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LOOKUP_CONCURRENCY = 8;
const Q2 = { start: "2026-04-01", end: "2026-06-30" };
const Q3 = { start: "2026-07-01", end: "2026-09-30" };

interface Candidate {
  employee_code: string;
  employee_name: string;
  location_code: string;
  active: boolean;
  last_punch_ever: string;
  latest_scheduled: string;
  days_since_last_punch_to_latest_schedule: number;
  scheduled_days_after_last_punch: number;
  q2_scheduled_days_after: number;
  q3_scheduled_days_after: number;
  /** §1g: recent/future time_entries rows the nightly no longer refreshes —
   * ghosts, excluded from the evidence above, reported never dropped. */
  stale_recent_scheduled_rows: number;
}

/** §1g freshness reach: the nightly refreshes rows from ~14d back onward;
 * older rows are historical facts and are not freshness-tested. */
const FRESHNESS_LOOKBACK_DAYS = 14;

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const rawThreshold = Number(url.searchParams.get("threshold_days") ?? 14);
  const thresholdDays =
    Number.isInteger(rawThreshold) && rawThreshold >= 1 ? rawThreshold : 14;

  const supabase = createAdminClient();

  try {
    type EmpRow = {
      id: string;
      employee_code: string;
      employee_name: string;
      active: boolean;
      location_id: string;
      locations: { location_code: string } | null;
    };
    const emps: EmpRow[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("employees")
        .select("id, employee_code, employee_name, active, location_id, locations(location_code)")
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`employees read: ${error.message}`);
      emps.push(...((data ?? []) as unknown as EmpRow[]));
      if (!data || data.length < PAGE) break;
    }

    // §1g: per-location freshness reference — the last successful
    // cp_schedule nightly. Rows that run would have served but did not
    // refresh are ghosts. A location with no successful run recorded has
    // no reference; its rows are treated fresh and the response says so.
    const freshnessRef = new Map<string, string>(); // location_id -> started_at
    {
      const { data, error } = await supabase
        .from("ingest_runs")
        .select("location_id, started_at")
        .eq("source", "cp_schedule")
        .eq("status", "success")
        .order("started_at", { ascending: false })
        .range(0, 999);
      if (error) throw new Error(`freshness-ref read: ${error.message}`);
      for (const r of data ?? []) {
        const loc = String(r.location_id);
        if (!freshnessRef.has(loc)) freshnessRef.set(loc, String(r.started_at));
      }
    }
    const todayIso = new Date().toISOString().slice(0, 10);
    const freshnessFloorDate = addDaysIso(todayIso, -FRESHNESS_LOOKBACK_DAYS);

    const candidates: Candidate[] = [];
    let neverPunched = 0;
    let totalStaleRows = 0;
    const queue = [...emps];

    async function worker() {
      for (;;) {
        const emp = queue.shift();
        if (!emp) return;

        const { data: lastRow, error: lErr } = await supabase
          .from("v_worked_intervals")
          .select("entry_date")
          .eq("employee_id", emp.id)
          .order("entry_date", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lErr) throw new Error(`last-punch read (${emp.employee_code}): ${lErr.message}`);
        if (!lastRow) {
          neverPunched += 1;
          continue; // blind cohort — a data question, not a departure one
        }
        const lastPunch = String(lastRow.entry_date).slice(0, 10);

        // Scheduled dates AFTER the last punch, both schedule sources —
        // paged past the 1000-row cap with a stable order; a silent cap
        // here would understate exactly the longest (worst) candidates
        // (Codex should-fix 2026-08-25; the no-silent-caps rule).
        const after = new Set<string>();
        let staleRows = 0;
        const ref = freshnessRef.get(emp.location_id) ?? null;
        const SCHED_PAGE = 1000;
        for (let from = 0; ; from += SCHED_PAGE) {
          const { data, error } = await supabase
            .from("time_entries")
            .select("entry_date, updated_at")
            .eq("employee_id", emp.id)
            .eq("entry_type", "scheduled")
            .gt("entry_date", lastPunch)
            .order("entry_date", { ascending: true })
            .order("id", { ascending: true })
            .range(from, from + SCHED_PAGE - 1);
          if (error) throw new Error(`schedule read (${emp.employee_code}): ${error.message}`);
          for (const r of data ?? []) {
            const d = String(r.entry_date).slice(0, 10);
            // §1g freshness test — only within the nightly's refresh reach,
            // and only when a reference run exists.
            if (
              ref !== null &&
              d >= freshnessFloorDate &&
              Date.parse(String(r.updated_at)) < Date.parse(ref)
            ) {
              staleRows += 1; // ghost: no signal in either direction
              continue;
            }
            after.add(d);
          }
          if (!data || data.length < SCHED_PAGE) break;
        }
        totalStaleRows += staleRows;
        for (let from = 0; ; from += SCHED_PAGE) {
          const { data, error } = await supabase
            .from("seven_shifts_shifts")
            .select("entry_date")
            .eq("employee_id", emp.id)
            .is("missing_upstream_since", null)
            .gt("entry_date", lastPunch)
            .order("entry_date", { ascending: true })
            .order("seven_shifts_shift_id", { ascending: true })
            .range(from, from + SCHED_PAGE - 1);
          if (error) throw new Error(`shifts read (${emp.employee_code}): ${error.message}`);
          for (const r of data ?? []) after.add(String(r.entry_date).slice(0, 10));
          if (!data || data.length < SCHED_PAGE) break;
        }
        if (after.size === 0) continue;

        const dates = [...after].sort();
        const latestScheduled = dates[dates.length - 1];
        if (latestScheduled <= addDaysIso(lastPunch, thresholdDays)) continue;

        const spanDays = Math.round(
          (Date.parse(`${latestScheduled}T12:00:00Z`) -
            Date.parse(`${lastPunch}T12:00:00Z`)) /
            86_400_000
        );
        candidates.push({
          employee_code: emp.employee_code,
          employee_name: emp.employee_name,
          location_code: emp.locations?.location_code ?? "?",
          active: emp.active,
          last_punch_ever: lastPunch,
          latest_scheduled: latestScheduled,
          days_since_last_punch_to_latest_schedule: spanDays,
          scheduled_days_after_last_punch: dates.length,
          q2_scheduled_days_after: dates.filter(
            (d) => d >= Q2.start && d <= Q2.end
          ).length,
          q3_scheduled_days_after: dates.filter(
            (d) => d >= Q3.start && d <= Q3.end
          ).length,
          stale_recent_scheduled_rows: staleRows,
        });
      }
    }
    await Promise.all(Array.from({ length: LOOKUP_CONCURRENCY }, worker));

    candidates.sort(
      (a, b) =>
        b.q3_scheduled_days_after - a.q3_scheduled_days_after ||
        b.scheduled_days_after_last_punch - a.scheduled_days_after_last_punch ||
        a.employee_code.localeCompare(b.employee_code)
    );

    const perStore: Record<string, { candidates: number; q2_days: number; q3_days: number }> = {};
    for (const c of candidates) {
      const s = perStore[c.location_code] ?? { candidates: 0, q2_days: 0, q3_days: 0 };
      s.candidates += 1;
      s.q2_days += c.q2_scheduled_days_after;
      s.q3_days += c.q3_scheduled_days_after;
      perStore[c.location_code] = s;
    }

    return NextResponse.json({
      report: "departure-candidates",
      threshold_days: thresholdDays,
      rule: `latest scheduled date > last punch ever + ${thresholdDays} days; employees with no punch ever excluded (blind cohort, §3d)`,
      freshness_rule: `§1g: time_entries scheduled rows dated >= today−${FRESHNESS_LOOKBACK_DAYS}d count as evidence only if refreshed by the location's last successful cp_schedule run — a stale row is a ghost the mirror cannot tombstone, excluded from evidence, counted here`,
      stale_recent_scheduled_rows_total: totalStaleRows,
      freshness_reference_locations: freshnessRef.size,
      employees_examined: emps.length,
      never_punched_excluded: neverPunched,
      candidate_count: candidates.length,
      by_store: perStore,
      candidates,
      note:
        "CANDIDATES, NOT CONCLUSIONS — Tucker confirms. Setting active/archived_at, changing denominators, and touching published Q3 are out of scope here (§7b: separate packet).",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[departure-candidates] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
