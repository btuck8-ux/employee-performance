import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadToastLaborLocations } from "@/lib/ingest/toast/labor";

/**
 * Worked-time reconciliation (workstream I §5.6 / Addendum 2 §2.5) —
 * READ-ONLY. Per employee-day at the 7 Toast stores, over each store's
 * go-live → today window: is a scheduled day covered by an EPD worked entry
 * (the 7shifts-sourced feed), a Toast punch (the direct feed), both, or
 * neither?
 *
 * The headline number: scheduled-unworked days (currently scored as missed)
 * that HAVE a Toast punch — recoverable data, not behaviour. That figure
 * converts the retraction's "317 unexplained" into a real split between
 * missing data and real absence, and it is what the THQ restatement waits
 * on ("nothing goes to THQ until the split is measured").
 *
 * Coverage caveat reported, not hidden: Toast punches only show for
 * CROSSWALKED employees — unattributed punch-days are counted per store so
 * the denominator's blind spot is always visible alongside the split.
 *
 * AUTH: Bearer <CRON_SECRET>.
 *   GET /api/admin/reconcile-worked-time
 *     ?start=YYYY-MM-DD&end=YYYY-MM-DD  (default: each store's go-live → today)
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type DaySets = Map<string, Set<string>>;

function add(map: DaySets, key: string, date: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(date);
  map.set(key, set);
}

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const startOverride = url.searchParams.get("start");
  const end = url.searchParams.get("end") ?? new Date().toISOString().slice(0, 10);

  try {
    const supabase = createAdminClient();
    const locations = await loadToastLaborLocations(supabase);

    const perStore: Array<Record<string, unknown>> = [];
    const totals = {
      scheduled_days: 0,
      worked_and_toast_punch: 0,
      worked_no_toast_punch: 0,
      toast_punch_no_worked: 0,
      neither: 0,
      unattributed_toast_punch_days: 0,
    };
    const recoveredByEmployee = new Map<string, number>();
    const codeById = new Map<string, string>();

    for (const loc of locations) {
      // An operator override never reaches back past go-live — pre-go-live
      // scheduled days would all read "neither" and inflate the split
      // (Codex 2026-08-23).
      const start =
        startOverride && startOverride > loc.labor_start_date
          ? startOverride
          : loc.labor_start_date;

      const empIds: string[] = [];
      const EMP_BATCH = 1000;
      for (let from = 0; ; from += EMP_BATCH) {
        const { data: emps, error: empError } = await supabase
          .from("employees")
          .select("id, employee_code")
          .eq("location_id", loc.id)
          .order("id", { ascending: true })
          .range(from, from + EMP_BATCH - 1);
        if (empError) throw new Error(`employees: ${empError.message}`);
        for (const e of emps ?? []) {
          empIds.push(String(e.id));
          codeById.set(String(e.id), e.employee_code);
        }
        if (!emps || emps.length < EMP_BATCH) break;
      }

      // time_entries READ (scheduled + worked), paged.
      const scheduled: DaySets = new Map();
      const worked: DaySets = new Map();
      const BATCH = 1000;
      for (let from = 0; ; from += BATCH) {
        const { data, error } = await supabase
          .from("time_entries")
          .select("employee_id, entry_date, entry_type")
          .in("employee_id", empIds)
          .gte("entry_date", start)
          .lte("entry_date", end)
          .in("entry_type", ["scheduled", "worked"])
          .order("entry_date", { ascending: true })
          .range(from, from + BATCH - 1);
        if (error) throw new Error(`time_entries: ${error.message}`);
        for (const r of data ?? []) {
          const empId = String(r.employee_id);
          const d = String(r.entry_date).slice(0, 10);
          add(r.entry_type === "worked" ? worked : scheduled, empId, d);
        }
        if (!data || data.length < BATCH) break;
      }

      // Toast punches, paged: attributed feed the split; unattributed feed
      // the blind-spot counter.
      const punches: DaySets = new Map();
      let unattributedPunchDays = 0;
      const unattributedSeen = new Set<string>();
      for (let from = 0; ; from += BATCH) {
        const { data, error } = await supabase
          .from("toast_time_entries")
          .select("employee_id, toast_employee_guid, entry_date")
          .eq("location_id", loc.id)
          .eq("deleted", false)
          .gte("entry_date", start)
          .lte("entry_date", end)
          .order("entry_date", { ascending: true })
          .range(from, from + BATCH - 1);
        if (error) throw new Error(`toast_time_entries: ${error.message}`);
        for (const r of data ?? []) {
          const d = String(r.entry_date).slice(0, 10);
          if (r.employee_id) {
            add(punches, String(r.employee_id), d);
          } else {
            const key = `${r.toast_employee_guid}|${d}`;
            if (!unattributedSeen.has(key)) {
              unattributedSeen.add(key);
              unattributedPunchDays += 1;
            }
          }
        }
        if (!data || data.length < BATCH) break;
      }

      const store = {
        scheduled_days: 0,
        worked_and_toast_punch: 0,
        worked_no_toast_punch: 0,
        toast_punch_no_worked: 0,
        neither: 0,
      };
      for (const [empId, days] of scheduled) {
        const workedSet = worked.get(empId) ?? new Set<string>();
        const punchSet = punches.get(empId) ?? new Set<string>();
        for (const d of days) {
          store.scheduled_days += 1;
          const w = workedSet.has(d);
          const p = punchSet.has(d);
          if (w && p) store.worked_and_toast_punch += 1;
          else if (w) store.worked_no_toast_punch += 1;
          else if (p) {
            store.toast_punch_no_worked += 1;
            recoveredByEmployee.set(empId, (recoveredByEmployee.get(empId) ?? 0) + 1);
          } else store.neither += 1;
        }
      }

      totals.scheduled_days += store.scheduled_days;
      totals.worked_and_toast_punch += store.worked_and_toast_punch;
      totals.worked_no_toast_punch += store.worked_no_toast_punch;
      totals.toast_punch_no_worked += store.toast_punch_no_worked;
      totals.neither += store.neither;
      totals.unattributed_toast_punch_days += unattributedPunchDays;

      perStore.push({
        location_code: loc.location_code,
        window: { start, end },
        ...store,
        unattributed_toast_punch_days: unattributedPunchDays,
      });
    }

    const recoveredTop = [...recoveredByEmployee.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([empId, days]) => ({
        employee_code: codeById.get(empId) ?? empId,
        scheduled_unworked_days_with_toast_punch: days,
      }));

    return NextResponse.json({
      report: "worked-time-reconciliation",
      note: "READ-ONLY. headline = toast_punch_no_worked: scheduled days currently scored as missed that have a Toast punch (recoverable data). Toast side only visible for crosswalked employees — unattributed_toast_punch_days is the blind spot.",
      totals: {
        ...totals,
        headline_scheduled_unworked_with_toast_punch: totals.toast_punch_no_worked,
        scheduled_unworked_total: totals.toast_punch_no_worked + totals.neither,
      },
      per_store: perStore,
      recovered_top_employees: recoveredTop,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[reconcile-worked-time] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
