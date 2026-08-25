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
}

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

    const candidates: Candidate[] = [];
    let neverPunched = 0;
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

        // Scheduled dates AFTER the last punch, both schedule sources.
        const after = new Set<string>();
        const { data: teRows, error: teErr } = await supabase
          .from("time_entries")
          .select("entry_date")
          .eq("employee_id", emp.id)
          .eq("entry_type", "scheduled")
          .gt("entry_date", lastPunch)
          .range(0, 999);
        if (teErr) throw new Error(`schedule read (${emp.employee_code}): ${teErr.message}`);
        for (const r of teRows ?? []) after.add(String(r.entry_date).slice(0, 10));
        const { data: shiftRows, error: shErr } = await supabase
          .from("seven_shifts_shifts")
          .select("entry_date")
          .eq("employee_id", emp.id)
          .is("missing_upstream_since", null)
          .gt("entry_date", lastPunch)
          .range(0, 999);
        if (shErr) throw new Error(`shifts read (${emp.employee_code}): ${shErr.message}`);
        for (const r of shiftRows ?? []) after.add(String(r.entry_date).slice(0, 10));
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
