import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchEffectiveEntries, fetchLocationFlipMeta } from "@/lib/flip-entries";
import {
  DISCARDED_PUNCH_SIGNAL,
  isConvictingStatus,
  LATE_NONE_SIGNAL,
  SEED_EVIDENCE,
  seedVerdictForGapDay,
  SIGNAL_CONTRADICTION_SUFFIX,
  TAGGART_EVIDENCE,
  TAGGART_SEVEN_SHIFTS_USER_ID,
  type AttendedSignal,
  type GapVerdict,
} from "@/lib/gap-ledger";

/**
 * The Q2 2026 verdict ledger (Q2 punch-recovery spec REVISED 2, 2026-08-25
 * §5b) — GET /api/admin/q2-gap-ledger.
 *
 * THE DELIVERABLE IS THE LEDGER, not a backfill: one row per Q2 gap day
 * (scheduled day, no punch from either punch source), each with exactly one
 * verdict — punch_recovered / confirmed_absent / scheduled_after_departure /
 * still_unknown. Q2 is recomputed once, when still_unknown is a number
 * Tucker has seen and accepted (§7). Nothing publishes before that.
 *
 * MODES:
 *   (default)       report — read q2_gap_ledger and count verdicts/signals
 *                   per store; list still_unknown by employee.
 *   ?seed=1         dry-run of the seeding: compute the gap days + rule
 *                   verdicts (§3d) and report what WOULD be inserted.
 *   ?seed=1&write=1 insert. NEVER overwrites an existing row — human
 *                   confirmations and recovery marks are append-only facts;
 *                   re-seeding reports inserted vs already_present.
 *
 * HOW GAP DAYS ARE COMPUTED — via flip-entries fetchEffectiveEntries, the
 * exact source layer scoring uses, so the ledger reconciles with stored
 * attendance_pct BY CONSTRUCTION (§3a: matched days over scheduled days).
 * This also honors §0's trap: no raw time_entries counting — the punch side
 * is the era-correct union (§3b) inside the same layer.
 *
 * SEED RULES (gap-ledger.ts; §3e-i ORDER OF OPERATIONS — the attended
 * signals run FIRST, on every gap day, before any shape rule):
 *   0a. late/none conviction (§3e)  → still_unknown + signal
 *   0b. discarded punch (§5b-i)     → still_unknown + signal
 *   1.  after-last-punch-ever       → scheduled_after_departure
 *   2.  blind                       → still_unknown
 *   3.  sighted                     → confirmed_absent (weakest, last)
 * Eleven of the twelve late/none days fall on SIGHTED days — shape-first
 * seeding would have sealed them as absences while a flag in the same
 * database says the person showed up. no_show contributes to NO verdict in
 * either direction. Taggart Dickson (7shifts 9867936) carries his §7a
 * Tucker confirmation, which outranks even the signals — a contradiction
 * is recorded in his evidence, never silently resolved.
 *
 * THE DELIBERATE time_entries READ (§5b-i): the route queries WORKED
 * time_entries rows for gap employees to find punches the flip stopped
 * reading (the HOU cutover class, 04-30→05-03: 7shifts punch exists, no
 * Toast row, Toast store on/after go-live). Gap-day DERIVATION and punch
 * BOUNDS still come only from flip-entries / v_worked_intervals — this
 * extra read exists precisely to catch what those sources discard, and is
 * consciously allowlisted in the flip reader sweep.
 *
 * AUTH: Bearer <CRON_SECRET>. This route never touches performance_records.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Q2_START = "2026-04-01";
const Q2_END = "2026-06-30";
const PUNCH_LOOKUP_CONCURRENCY = 6;
const PAGE = 1000;

interface LedgerSeedRow {
  employee_id: string;
  employee_code: string;
  location_id: string;
  location_code: string;
  gap_date: string;
  verdict: GapVerdict;
  evidence: string;
  signal: string | null;
}

export async function GET(request: Request) {
  const denied = requireBearer(request, process.env.CRON_SECRET, "CRON_SECRET");
  if (denied) return denied;

  const url = new URL(request.url);
  const seed = url.searchParams.get("seed") === "1";
  const write = url.searchParams.get("write") === "1";

  const supabase = createAdminClient();

  try {
    if (!seed) {
      // ---- REPORT MODE ----
      type LedgerRow = {
        employee_id: string;
        location_id: string;
        gap_date: string;
        verdict: GapVerdict;
        signal: string | null;
        employees: { employee_code: string; employee_name: string } | null;
        locations: { location_code: string } | null;
      };
      const rows: LedgerRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("q2_gap_ledger")
          .select(
            "employee_id, location_id, gap_date, verdict, signal, employees(employee_code, employee_name), locations(location_code)"
          )
          .order("employee_id", { ascending: true })
          .order("gap_date", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`ledger read: ${error.message}`);
        rows.push(...((data ?? []) as unknown as LedgerRow[]));
        if (!data || data.length < PAGE) break;
      }

      const byVerdict: Record<string, number> = {};
      const byStore = new Map<string, Record<string, number>>();
      const signalCounts: Record<string, number> = {};
      const unknownByEmployee = new Map<
        string,
        { employee: string; store: string; days: number; signal_days: number }
      >();
      for (const r of rows) {
        byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
        const store = r.locations?.location_code ?? "?";
        const s = byStore.get(store) ?? {};
        s[r.verdict] = (s[r.verdict] ?? 0) + 1;
        byStore.set(store, s);
        if (r.signal) signalCounts[r.signal] = (signalCounts[r.signal] ?? 0) + 1;
        if (r.verdict === "still_unknown") {
          const key = r.employee_id;
          const e = unknownByEmployee.get(key) ?? {
            employee: `${r.employees?.employee_code ?? "?"} ${r.employees?.employee_name ?? "?"}`,
            store,
            days: 0,
            signal_days: 0,
          };
          e.days += 1;
          if (r.signal) e.signal_days += 1;
          unknownByEmployee.set(key, e);
        }
      }

      return NextResponse.json({
        ledger: "q2-gap-ledger",
        quarter: "Q2-2026",
        total_days: rows.length,
        by_verdict: byVerdict,
        attended_signals: signalCounts,
        by_store: Object.fromEntries(byStore),
        still_unknown_by_employee: [...unknownByEmployee.values()].sort(
          (a, b) => b.days - a.days || a.employee.localeCompare(b.employee)
        ),
        note:
          rows.length === 0
            ? "ledger is empty — run ?seed=1 (dry-run), review, then &write=1"
            : "Q2 recompute waits until still_unknown is a number Tucker has seen and accepted (§7)",
      });
    }

    // ---- SEED MODE (dry-run default) ----
    type LocRow = { id: string; location_code: string };
    const { data: locRows, error: locErr } = await supabase
      .from("locations")
      .select("id, location_code")
      .order("location_code", { ascending: true });
    if (locErr) throw new Error(`locations read: ${locErr.message}`);
    const locations = (locRows ?? []) as LocRow[];

    const seeds: LedgerSeedRow[] = [];
    const perStore: Record<
      string,
      { gap_days: number; employees: number; by_verdict: Record<string, number> }
    > = {};

    for (const loc of locations) {
      // Every employee row at the store — active or departed; gap days can
      // only emerge from scheduled entries, so over-inclusion is free.
      type EmpRow = {
        id: string;
        employee_code: string;
        seven_shifts_user_id: number | null;
      };
      const emps: EmpRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("employees")
          .select("id, employee_code, seven_shifts_user_id")
          .eq("location_id", loc.id)
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`employees read (${loc.location_code}): ${error.message}`);
        emps.push(...((data ?? []) as EmpRow[]));
        if (!data || data.length < PAGE) break;
      }
      if (emps.length === 0) continue;

      // The scoring source layer — gap days reconcile with attendance_pct
      // by construction (§3a).
      const meta = await fetchLocationFlipMeta(supabase, loc.id);
      const byEmployee = await fetchEffectiveEntries(
        supabase,
        loc.id,
        emps.map((e) => e.id),
        { start: Q2_START, end: Q2_END },
        meta
      );

      // Gap days per employee: scheduled dates with no worked date.
      const gapsByEmployee = new Map<string, string[]>();
      for (const emp of emps) {
        const entries = byEmployee.get(emp.id) ?? [];
        const scheduled = new Set<string>();
        const worked = new Set<string>();
        for (const e of entries) {
          if (e.entry_type === "scheduled") scheduled.add(e.entry_date);
          else worked.add(e.entry_date);
        }
        const gaps = [...scheduled].filter((d) => !worked.has(d)).sort();
        if (gaps.length > 0) gapsByEmployee.set(emp.id, gaps);
      }
      if (gapsByEmployee.size === 0) {
        perStore[loc.location_code] = { gap_days: 0, employees: 0, by_verdict: {} };
        continue;
      }

      // First/last punch EVER per gap employee — v_worked_intervals, the
      // era-correct union; never raw time_entries (§0's trap).
      const punchBounds = new Map<
        string,
        { first: string | null; last: string | null }
      >();
      {
        const queue = [...gapsByEmployee.keys()];
        async function worker() {
          for (;;) {
            const id = queue.shift();
            if (!id) return;
            const { data: firstRow, error: fErr } = await supabase
              .from("v_worked_intervals")
              .select("entry_date")
              .eq("employee_id", id)
              .order("entry_date", { ascending: true })
              .limit(1)
              .maybeSingle();
            if (fErr) throw new Error(`first-punch read: ${fErr.message}`);
            const { data: lastRow, error: lErr } = await supabase
              .from("v_worked_intervals")
              .select("entry_date")
              .eq("employee_id", id)
              .order("entry_date", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (lErr) throw new Error(`last-punch read: ${lErr.message}`);
            punchBounds.set(id, {
              first: firstRow ? String(firstRow.entry_date).slice(0, 10) : null,
              last: lastRow ? String(lastRow.entry_date).slice(0, 10) : null,
            });
          }
        }
        await Promise.all(
          Array.from({ length: PUNCH_LOOKUP_CONCURRENCY }, worker)
        );
      }

      // §3e convictions for this store's gap employees: late/none rows in
      // the direct shift feed (pruned) inside Q2. The table reaches back to
      // 2026-06-01 until §3f extends it — April/May convictions appear
      // automatically once that backfill lands and the seed is re-run.
      const convicted = new Set<string>(); // `${employee_id}|${date}`
      {
        const ids = [...gapsByEmployee.keys()];
        for (let i = 0; i < ids.length; i += 100) {
          const { data, error } = await supabase
            .from("seven_shifts_shifts")
            .select("employee_id, entry_date, attendance_status")
            .in("employee_id", ids.slice(i, i + 100))
            .gte("entry_date", Q2_START)
            .lte("entry_date", Q2_END)
            .is("missing_upstream_since", null)
            .range(0, 9999);
          if (error) throw new Error(`shift-status read: ${error.message}`);
          for (const r of data ?? []) {
            if (isConvictingStatus(r.attendance_status as string | null)) {
              convicted.add(`${r.employee_id}|${String(r.entry_date).slice(0, 10)}`);
            }
          }
        }
      }

      // §5b-i: worked time_entries rows for this store's gap employees —
      // a punch on a gap day here is one the flip DISCARDED (had the
      // effective view included it, the day would not be a gap). The read
      // is deliberate and allowlisted; entry_type='worked' per §0's trap.
      const discarded = new Set<string>(); // `${employee_id}|${date}`
      {
        const ids = [...gapsByEmployee.keys()];
        for (let i = 0; i < ids.length; i += 100) {
          for (let from = 0; ; from += PAGE) {
            const { data, error } = await supabase
              .from("time_entries")
              .select("employee_id, entry_date")
              .in("employee_id", ids.slice(i, i + 100))
              .eq("entry_type", "worked")
              .gte("entry_date", Q2_START)
              .lte("entry_date", Q2_END)
              .order("employee_id", { ascending: true })
              .order("entry_date", { ascending: true })
              .range(from, from + PAGE - 1);
            if (error) throw new Error(`discarded-punch read: ${error.message}`);
            for (const r of data ?? []) {
              discarded.add(`${r.employee_id}|${String(r.entry_date).slice(0, 10)}`);
            }
            if (!data || data.length < PAGE) break;
          }
        }
      }

      const storeVerdicts: Record<string, number> = {};
      for (const emp of emps) {
        const gaps = gapsByEmployee.get(emp.id);
        if (!gaps) continue;
        const bounds = punchBounds.get(emp.id) ?? { first: null, last: null };
        for (const gapDate of gaps) {
          const key = `${emp.id}|${gapDate}`;
          // §3e-i: the attended signal is resolved BEFORE any rule runs —
          // for every gap day, not only days some other rule left open.
          const attendedSignal: AttendedSignal | null = convicted.has(key)
            ? "late_none"
            : discarded.has(key)
              ? "discarded_punch"
              : null;
          const ruled = seedVerdictForGapDay({
            gapDate,
            firstPunchEver: bounds.first,
            lastPunchEver: bounds.last,
            attendedSignal,
          });
          const isTaggart =
            emp.seven_shifts_user_id === TAGGART_SEVEN_SHIFTS_USER_ID;
          // Human confirmation outranks even the signals — but a
          // contradiction is RECORDED, never silently resolved.
          const verdict: GapVerdict = isTaggart ? "confirmed_absent" : ruled.verdict;
          const evidence = isTaggart
            ? TAGGART_EVIDENCE +
              (attendedSignal !== null ? SIGNAL_CONTRADICTION_SUFFIX : "")
            : SEED_EVIDENCE[ruled.reason];
          seeds.push({
            employee_id: emp.id,
            employee_code: emp.employee_code,
            location_id: loc.id,
            location_code: loc.location_code,
            gap_date: gapDate,
            verdict,
            evidence,
            signal:
              attendedSignal === "late_none"
                ? LATE_NONE_SIGNAL
                : attendedSignal === "discarded_punch"
                  ? DISCARDED_PUNCH_SIGNAL
                  : null,
          });
          storeVerdicts[verdict] = (storeVerdicts[verdict] ?? 0) + 1;
        }
      }
      perStore[loc.location_code] = {
        gap_days: seeds.filter((s) => s.location_id === loc.id).length,
        employees: gapsByEmployee.size,
        by_verdict: storeVerdicts,
      };
    }

    const byVerdict: Record<string, number> = {};
    for (const s of seeds) byVerdict[s.verdict] = (byVerdict[s.verdict] ?? 0) + 1;
    const summary = {
      ledger: "q2-gap-ledger",
      quarter: "Q2-2026",
      window: { start: Q2_START, end: Q2_END },
      mode: write ? "write" : "dry_run",
      computed_gap_days: seeds.length,
      employees_with_gaps: new Set(seeds.map((s) => s.employee_id)).size,
      by_verdict: byVerdict,
      attended_signals: {
        late_none_conviction: seeds.filter((s) => s.signal === LATE_NONE_SIGNAL)
          .length,
        discarded_punch_at_cutover: seeds.filter(
          (s) => s.signal === DISCARDED_PUNCH_SIGNAL
        ).length,
      },
      // The spec's measured shape (§5b-i / §10 — 463, not the retracted
      // 458), for reconciliation at a glance. The 12 late/none and 5
      // cutover-discard days seed still_unknown with evidence attached, so
      // computed still_unknown reads HIGHER and confirmed_absent LOWER
      // than the pure shape-rule split — that drift is the §3e-i fix
      // working. Drift is also expected once backfills land; a large
      // unexplained drift BEFORE any backfill is a computation question.
      spec_expectation: {
        total: 463,
        still_unknown: 230,
        confirmed_absent: 210,
        scheduled_after_departure: 23,
        note: "§10 shape-rule figures; the 12 + 5 signal days move from confirmed_absent into still_unknown per §3e-i / §5b-i",
      },
    };

    if (!write) {
      return NextResponse.json({
        ...summary,
        note: "dry_run — nothing written; re-run with &write=1 to insert (existing rows are never overwritten)",
        sample: seeds.slice(0, 25).map((s) => ({
          employee: s.employee_code,
          store: s.location_code,
          gap_date: s.gap_date,
          verdict: s.verdict,
          signal: s.signal,
        })),
      });
    }

    // WRITE: insert-only. ignoreDuplicates keeps every existing verdict —
    // a re-seed must never clobber a Tucker confirmation or a recovery mark.
    let inserted = 0;
    const CHUNK = 500;
    for (let i = 0; i < seeds.length; i += CHUNK) {
      const chunk = seeds.slice(i, i + CHUNK).map((s) => ({
        employee_id: s.employee_id,
        location_id: s.location_id,
        gap_date: s.gap_date,
        verdict: s.verdict,
        evidence: s.evidence,
        signal: s.signal,
      }));
      const { data, error } = await supabase
        .from("q2_gap_ledger")
        .upsert(chunk, {
          onConflict: "employee_id,gap_date",
          ignoreDuplicates: true,
        })
        .select("id");
      if (error) throw new Error(`ledger insert: ${error.message}`);
      inserted += (data ?? []).length;
    }

    return NextResponse.json({
      ...summary,
      inserted,
      already_present: seeds.length - inserted,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[q2-gap-ledger] fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
