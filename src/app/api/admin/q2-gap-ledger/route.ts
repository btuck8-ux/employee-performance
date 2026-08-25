import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchEffectiveEntries, fetchLocationFlipMeta } from "@/lib/flip-entries";
import {
  isConvictingStatus,
  LATE_NONE_EVIDENCE_SUFFIX,
  LATE_NONE_SIGNAL,
  SEED_EVIDENCE,
  seedVerdictForGapDay,
  TAGGART_EVIDENCE,
  TAGGART_SEVEN_SHIFTS_USER_ID,
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
 * SEED RULES (gap-ledger.ts, precedence order): after-last-punch-ever →
 * scheduled_after_departure · blind → still_unknown · sighted →
 * confirmed_absent. Taggart Dickson (7shifts 9867936) carries his §7a
 * Tucker confirmation as evidence. §3e late/none convictions land as a
 * SIGNAL on still_unknown days (confirmed missing punch ≠ recovered).
 *
 * AUTH: Bearer <CRON_SECRET>. Read-only against scoring surfaces — this
 * route never touches performance_records or time_entries.
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
      let convictions = 0;
      const unknownByEmployee = new Map<
        string,
        { employee: string; store: string; days: number; convicted_days: number }
      >();
      for (const r of rows) {
        byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
        const store = r.locations?.location_code ?? "?";
        const s = byStore.get(store) ?? {};
        s[r.verdict] = (s[r.verdict] ?? 0) + 1;
        byStore.set(store, s);
        if (r.signal === LATE_NONE_SIGNAL) convictions += 1;
        if (r.verdict === "still_unknown") {
          const key = r.employee_id;
          const e = unknownByEmployee.get(key) ?? {
            employee: `${r.employees?.employee_code ?? "?"} ${r.employees?.employee_name ?? "?"}`,
            store,
            days: 0,
            convicted_days: 0,
          };
          e.days += 1;
          if (r.signal === LATE_NONE_SIGNAL) e.convicted_days += 1;
          unknownByEmployee.set(key, e);
        }
      }

      return NextResponse.json({
        ledger: "q2-gap-ledger",
        quarter: "Q2-2026",
        total_days: rows.length,
        by_verdict: byVerdict,
        confirmed_missing_punch_signals: convictions,
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

      const storeVerdicts: Record<string, number> = {};
      for (const emp of emps) {
        const gaps = gapsByEmployee.get(emp.id);
        if (!gaps) continue;
        const bounds = punchBounds.get(emp.id) ?? { first: null, last: null };
        for (const gapDate of gaps) {
          const ruled = seedVerdictForGapDay({
            gapDate,
            firstPunchEver: bounds.first,
            lastPunchEver: bounds.last,
          });
          const isTaggart =
            emp.seven_shifts_user_id === TAGGART_SEVEN_SHIFTS_USER_ID;
          const convictedHere =
            ruled.verdict === "still_unknown" &&
            convicted.has(`${emp.id}|${gapDate}`);
          seeds.push({
            employee_id: emp.id,
            employee_code: emp.employee_code,
            location_id: loc.id,
            location_code: loc.location_code,
            gap_date: gapDate,
            verdict: ruled.verdict,
            evidence: isTaggart
              ? TAGGART_EVIDENCE
              : SEED_EVIDENCE[ruled.reason] +
                (convictedHere ? LATE_NONE_EVIDENCE_SUFFIX : ""),
            signal: convictedHere ? LATE_NONE_SIGNAL : null,
          });
          storeVerdicts[ruled.verdict] = (storeVerdicts[ruled.verdict] ?? 0) + 1;
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
      confirmed_missing_punch_signals: seeds.filter(
        (s) => s.signal === LATE_NONE_SIGNAL
      ).length,
      by_store: perStore,
      // The spec's measured shape, for reconciliation at a glance — drift
      // is expected once backfills land; a large drift BEFORE any backfill
      // is a computation question.
      spec_expectation: {
        total: 458,
        still_unknown: 230,
        confirmed_absent: 205,
        scheduled_after_departure: 23,
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
