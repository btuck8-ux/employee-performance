/**
 * §4b PREDICATE AUDIT (packet 8 rev 2, 2026-08-27) — READ-ONLY, by
 * construction: every Supabase call is a select; nothing is written.
 *
 * Question (Cowork §4b): the shipped denominator correction excludes ~105
 * person-days in Q3 2026 while EPD's visible withdrawal record is 19 rows.
 * What is the exclusion predicate ACTUALLY keying on?
 *
 * Method: enumerate the same Q3-2026 job set as the dry-run, re-run the
 * computeMetricsFromEntries scheduled-day loop with per-date logging, and
 * classify every scheduled day that does NOT land in scheduled_count:
 *
 *   below_floor    entry_date < metrics_start_date (floor filter)
 *   beyond_cap     entry_date > scheduledScoredThrough (future/unconfirmed)
 *   removal_drop   the §3–§4 evidence predicate fired — subclassified by
 *                  what the mirror holds for (uid, date) at the location:
 *                    tombstoned      only rows with missing_upstream_since
 *                    deleted_flag    only rows with deleted = true
 *                    mixed_dead      both kinds of dead row, none live
 *                    never_mirrored  NO seven_shifts_shifts row at all
 *
 * A removal_drop can only be gated on withdrawal TIMING (the 4b ruling) if
 * a withdrawal timestamp exists — tombstoned rows have one; deleted_flag
 * rows and never_mirrored dates do not.
 *
 * Run:  node --env-file=.env.local scripts/exclusion-predicate-audit.ts
 */

import Module from "node:module";
import { writeFileSync } from "node:fs";

interface ResolveResult {
  url: string;
  shortCircuit?: boolean;
  format?: string | null;
}
type NextResolve = (specifier: string, context?: unknown) => ResolveResult;
const { registerHooks } = Module as unknown as {
  registerHooks: (hooks: {
    resolve: (
      specifier: string,
      context: unknown,
      nextResolve: NextResolve
    ) => ResolveResult;
  }) => void;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    let spec = specifier;
    if (spec.startsWith("@/")) {
      spec = new URL(`../src/${spec.slice(2)}`, import.meta.url).href;
    }
    try {
      return nextResolve(spec, context);
    } catch (err) {
      if (!spec.endsWith(".ts") && /^(\.{1,2}\/|file:)/.test(spec)) {
        return nextResolve(`${spec}.ts`, context);
      }
      throw err;
    }
  },
});

const { createClient } = await import("@supabase/supabase-js");
const { punchesTimeClockForPeriod } = await import(
  "../src/lib/performance-recompute.ts"
);
const {
  fetchLocationFlipMeta,
  fetchEffectiveEntries,
  latestEffectiveWorkedDate,
  fetchRemovedShiftEvidence,
} = await import("../src/lib/flip-entries.ts");
const { quarterInfo } = await import("../src/lib/quarter.ts");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const YEAR = 2026;
const QUARTER = 3 as const;
const todayIso = new Date().toISOString().slice(0, 10);

interface Excluded {
  store: string;
  employee_code: string;
  employee_name: string;
  seven_shifts_user_id: number | null;
  date: string;
  reason: string; // below_floor | beyond_cap | removal_drop
  subclass: string | null; // for removal_drop
  punches_time_clock: boolean;
}

const excluded: Excluded[] = [];
let totalScheduledDaysSeen = 0;
let totalCounted = 0;
let nonPuncherRows = 0;

const { data: locs, error: locErr } = await supabase
  .from("locations")
  .select("id, location_code, metrics_start_date")
  .order("location_code");
if (locErr || !locs) throw new Error(`locations: ${locErr?.message}`);

const q = quarterInfo(YEAR, QUARTER);
const periodStart = q.periodStart.toISOString().slice(0, 10);
const periodEnd = q.periodEnd.toISOString().slice(0, 10);

const { data: periods } = await supabase
  .from("report_periods")
  .select("id, year, quarter")
  .eq("year", YEAR)
  .eq("quarter", QUARTER);
const periodId = periods?.[0]?.id as string | undefined;

for (const loc of locs) {
  const { data: emps, error: empErr } = await supabase
    .from("employees")
    .select(
      "id, employee_code, employee_name, active, punches_time_clock, punches_time_clock_since, seven_shifts_user_id"
    )
    .eq("location_id", loc.id);
  if (empErr || !emps) throw new Error(`${loc.location_code}: ${empErr?.message}`);
  const empById = new Map(emps.map((e) => [e.id as string, e]));

  const storedIds = new Set<string>();
  if (periodId) {
    const { data: stored } = await supabase
      .from("performance_records")
      .select("employee_id")
      .eq("location_id", loc.id)
      .eq("report_period_id", periodId)
      .range(0, 9999);
    for (const r of stored ?? []) storedIds.add(String(r.employee_id));
  }
  const ids = [
    ...new Set([
      ...emps.filter((e) => e.active).map((e) => e.id as string),
      ...storedIds,
    ]),
  ].filter((id) => empById.has(id));

  const meta = await fetchLocationFlipMeta(supabase, loc.id as string);
  const latestWorked = await latestEffectiveWorkedDate(
    supabase,
    loc.id as string,
    meta
  );
  const cap =
    latestWorked !== null && latestWorked < todayIso ? latestWorked : todayIso;
  const floor = meta.metricsStart;

  const byEmployee = await fetchEffectiveEntries(
    supabase,
    loc.id as string,
    ids,
    { start: periodStart, end: periodEnd },
    meta
  );
  const evidence = await fetchRemovedShiftEvidence(supabase, loc.id as string, ids, {
    start: periodStart,
    end: periodEnd,
  });

  for (const id of ids) {
    const emp = empById.get(id)!;
    const entries = byEmployee.get(id) ?? [];
    if (entries.length === 0) continue;

    const punches = punchesTimeClockForPeriod(
      emp.punches_time_clock !== false,
      emp.punches_time_clock_since ?? null,
      periodEnd
    );
    if (!punches) nonPuncherRows += 1;

    const rs = evidence.get(id);
    const uidRaw = emp.seven_shifts_user_id;
    const uid =
      uidRaw === null || uidRaw === undefined ? null : Number(uidRaw);

    // Mirror computeMetricsFromEntries exactly: floor filter first, then
    // last-writer-wins by date into scheduled/worked maps.
    const scheduledByDate = new Map<string, { in_time: string | null }>();
    const workedByDate = new Set<string>();
    for (const e of entries) {
      if (floor !== null && e.entry_date < floor) {
        if (e.entry_type === "scheduled") {
          totalScheduledDaysSeen += 1;
          excluded.push({
            store: loc.location_code as string,
            employee_code: emp.employee_code as string,
            employee_name: emp.employee_name as string,
            seven_shifts_user_id: uid,
            date: e.entry_date,
            reason: "below_floor",
            subclass: null,
            punches_time_clock: punches,
          });
        }
        continue;
      }
      if (e.entry_type === "scheduled") scheduledByDate.set(e.entry_date, e);
      else workedByDate.add(e.entry_date);
    }

    for (const [date] of scheduledByDate) {
      totalScheduledDaysSeen += 1;
      if (date > cap) {
        excluded.push({
          store: loc.location_code as string,
          employee_code: emp.employee_code as string,
          employee_name: emp.employee_name as string,
          seven_shifts_user_id: uid,
          date,
          reason: "beyond_cap",
          subclass: null,
          punches_time_clock: punches,
        });
        continue;
      }
      const worked = workedByDate.has(date);
      if (!worked) {
        if (
          rs !== undefined &&
          rs.mirrorCoverageStart !== null &&
          rs.employeeCoverageStart !== null &&
          rs.liveDates !== null &&
          date >= rs.mirrorCoverageStart &&
          date >= rs.employeeCoverageStart &&
          !rs.liveDates.has(date)
        ) {
          excluded.push({
            store: loc.location_code as string,
            employee_code: emp.employee_code as string,
            employee_name: emp.employee_name as string,
            seven_shifts_user_id: uid,
            date,
            reason: "removal_drop",
            subclass: null, // filled below from the mirror
            punches_time_clock: punches,
          });
          continue;
        }
      }
      totalCounted += 1;
    }
  }
  console.log(`${loc.location_code}: done (cap ${cap}, floor ${floor ?? "none"})`);
}

// ── subclassify removal_drops from the mirror ───────────────────────────────
const drops = excluded.filter((e) => e.reason === "removal_drop");
const byLocUid = new Map<string, Excluded[]>();
for (const d of drops) {
  const k = `${d.store}|${d.seven_shifts_user_id}`;
  const arr = byLocUid.get(k) ?? [];
  arr.push(d);
  byLocUid.set(k, arr);
}
const locIdByCode = new Map(locs.map((l) => [l.location_code as string, l.id as string]));
for (const [k, arr] of byLocUid) {
  const [code, uidStr] = k.split("|");
  const uid = Number(uidStr);
  const dates = [...new Set(arr.map((d) => d.date))];
  const { data: rows, error } = await supabase
    .from("seven_shifts_shifts")
    .select("entry_date, deleted, draft, missing_upstream_since")
    .eq("location_id", locIdByCode.get(code)!)
    .eq("seven_shifts_user_id", uid)
    .in("entry_date", dates);
  if (error) throw new Error(`mirror subclass ${k}: ${error.message}`);
  const byDate = new Map<string, { tomb: number; del: number; live: number }>();
  for (const r of rows ?? []) {
    const d = String(r.entry_date).slice(0, 10);
    const rec = byDate.get(d) ?? { tomb: 0, del: 0, live: 0 };
    if (r.missing_upstream_since !== null) rec.tomb += 1;
    else if (r.deleted === true) rec.del += 1;
    else rec.live += 1;
    byDate.set(d, rec);
  }
  for (const d of arr) {
    const rec = byDate.get(d.date);
    if (!rec) d.subclass = "never_mirrored";
    else if (rec.live > 0) d.subclass = "HAS_LIVE_ROW_BUG"; // should be impossible
    else if (rec.tomb > 0 && rec.del > 0) d.subclass = "mixed_dead";
    else if (rec.tomb > 0) d.subclass = "tombstoned";
    else d.subclass = "deleted_flag";
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const count = (arr: Excluded[], f: (e: Excluded) => boolean) => arr.filter(f).length;

console.log(`\n== Q3-2026 SCHEDULED-DAY ACCOUNTING (estate-wide) ==`);
console.log(`scheduled days seen (incl. below-floor): ${totalScheduledDaysSeen}`);
console.log(`landed in scheduled_count             : ${totalCounted}`);
console.log(`excluded                              : ${excluded.length}`);
console.log(`  below_floor : ${count(excluded, (e) => e.reason === "below_floor")}`);
console.log(`  beyond_cap  : ${count(excluded, (e) => e.reason === "beyond_cap")}`);
console.log(`  removal_drop: ${drops.length}`);
for (const sub of ["tombstoned", "deleted_flag", "mixed_dead", "never_mirrored", "HAS_LIVE_ROW_BUG"]) {
  const n = count(drops, (e) => e.subclass === sub);
  if (n > 0 || sub !== "HAS_LIVE_ROW_BUG")
    console.log(`      ${sub.padEnd(14)}: ${n}`);
}
console.log(`(rows for punches_time_clock=false employees included above; excluded-person rows: ${nonPuncherRows})`);

console.log(`\n== removal_drop rows in full ==`);
for (const d of drops.sort((a, b) => (a.store + a.date).localeCompare(b.store + b.date))) {
  console.log(
    `${d.store} ${d.date} ${d.employee_code} ${d.employee_name} uid=${d.seven_shifts_user_id}: ${d.subclass}${d.punches_time_clock ? "" : "  [non-puncher row]"}`
  );
}

const perStore = new Map<string, Record<string, number>>();
for (const e of excluded) {
  const rec = perStore.get(e.store) ?? {};
  rec[e.reason] = (rec[e.reason] ?? 0) + 1;
  perStore.set(e.store, rec);
}
console.log(`\n== per-store exclusion mix ==`);
for (const [s, rec] of [...perStore.entries()].sort()) {
  console.log(
    `${s.padEnd(7)} below_floor ${String(rec.below_floor ?? 0).padStart(4)}  beyond_cap ${String(rec.beyond_cap ?? 0).padStart(4)}  removal_drop ${String(rec.removal_drop ?? 0).padStart(4)}`
  );
}

writeFileSync(
  "/tmp/packet8-exclusion-audit.json",
  JSON.stringify({ ranAt: new Date().toISOString(), periodStart, periodEnd, excluded }, null, 1)
);
console.log(`\nfull detail: /tmp/packet8-exclusion-audit.json  (read-only run — nothing was written)`);
