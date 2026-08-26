/**
 * §7.2 DRY-RUN RUNNER (packet 5, 2026-08-26) — READ-ONLY, by construction.
 *
 * Computes the "after" side of the denominator-spec recompute IN MEMORY
 * against the unmodified database, using the branch's OWN functions
 * (fetchEffectiveEntries / fetchRemovedShiftEvidence /
 * computeMetricsFromEntries) so the table reflects exactly what the
 * deployed recompute will produce — parity by construction, not by twin.
 * The "before" side is the stored performance_records values, read as
 * stored.
 *
 * Scope: per store × per quarter, from each store's floor forward.
 * Frozen quarters are OUT OF SCOPE (ruling 16) — skipped, never computed.
 *
 * The table has FOUR buckets (a diff keyed on value movement is blind to
 * the direction most changes actually take — 114 rows carry NULL
 * attendance in Q3 2026):
 *   value → different value | null → value | value → null | unchanged
 *
 * Expected direction: attendance RISES. Every numeric FALL is listed in
 * full — a fall anywhere is a finding, not an input to proceed on.
 *
 * Run:  node --env-file=.env.local scripts/denominator-dry-run.ts
 * Writes NOTHING. Every Supabase call in the imported helpers is a select.
 */

import Module from "node:module";

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
const {
  computeMetricsFromEntries,
  punchesTimeClockForPeriod,
} = await import("../src/lib/performance-recompute.ts");
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

type Quarter = 1 | 2 | 3 | 4;

interface EmployeeRow {
  id: string;
  employee_code: string;
  employee_name: string;
  active: boolean;
  punches_time_clock: boolean | null;
  punches_time_clock_since: string | null;
}

interface StoredRow {
  employee_id: string;
  attendance_pct: number | string | null;
}

type Bucket = "value_changed" | "null_to_value" | "value_to_null" | "unchanged";

interface DiffRow {
  store: string;
  period: string;
  employee_code: string;
  employee_name: string;
  active: boolean;
  hadRow: boolean;
  before: number | null;
  after: number | null;
  bucket: Bucket;
  schedBefore: number | null;
  schedAfter: number;
  attendedAfter: number;
  wouldCreateRow: boolean;
}

const num = (v: number | string | null): number | null =>
  v === null || v === undefined ? null : Number(v);

const todayIso = new Date().toISOString().slice(0, 10);

// ── locations + their floors ────────────────────────────────────────────────
const { data: locs, error: locErr } = await supabase
  .from("locations")
  .select("id, location_code, metrics_start_date")
  .order("location_code");
if (locErr || !locs) throw new Error(`locations: ${locErr?.message}`);

// ── frozen periods (ruling 16: skipped, never computed) ─────────────────────
const { data: periods, error: perErr } = await supabase
  .from("report_periods")
  .select("id, year, quarter, frozen");
if (perErr) throw new Error(`report_periods: ${perErr.message}`);
const frozenSet = new Set(
  (periods ?? []).filter((p) => p.frozen === true).map((p) => `Q${p.quarter}-${p.year}`)
);
const periodIdByLabel = new Map(
  (periods ?? []).map((p) => [`Q${p.quarter}-${p.year}`, p.id as string])
);

function targetQuarters(floor: string): Array<{ year: number; quarter: Quarter }> {
  const out: Array<{ year: number; quarter: Quarter }> = [];
  let y = Number(floor.slice(0, 4));
  let q = (Math.floor((Number(floor.slice(5, 7)) - 1) / 3) + 1) as Quarter;
  const curY = Number(todayIso.slice(0, 4));
  const curQ = (Math.floor((Number(todayIso.slice(5, 7)) - 1) / 3) + 1) as Quarter;
  while (y < curY || (y === curY && q <= curQ)) {
    const label = `Q${q}-${y}`;
    // Ruling 16 belt-and-braces: 2025 quarters are pre-demarcation history;
    // skip them even if a frozen flag were ever missing.
    if (!frozenSet.has(label) && y >= 2026) out.push({ year: y, quarter: q });
    q = (q === 4 ? 1 : ((q + 1) as Quarter)) as Quarter;
    if (q === 1) y += 1;
  }
  return out;
}

const allDiffs: DiffRow[] = [];
const storeQuarterSummaries: string[] = [];

for (const loc of locs) {
  const floor = loc.metrics_start_date as string | null;
  if (!floor) throw new Error(`${loc.location_code}: NULL floor — mig 080 says this cannot happen`);
  const quarters = targetQuarters(floor);
  if (quarters.length === 0) continue;

  const { data: emps, error: empErr } = await supabase
    .from("employees")
    .select(
      "id, employee_code, employee_name, active, punches_time_clock, punches_time_clock_since"
    )
    .eq("location_id", loc.id);
  if (empErr || !emps) throw new Error(`${loc.location_code} employees: ${empErr?.message}`);
  const empById = new Map((emps as EmployeeRow[]).map((e) => [e.id, e]));

  const meta = await fetchLocationFlipMeta(supabase, loc.id as string);
  const latestWorked = await latestEffectiveWorkedDate(supabase, loc.id as string, meta);
  const scheduledScoredThrough =
    latestWorked !== null && latestWorked < todayIso ? latestWorked : todayIso;

  for (const { year, quarter } of quarters) {
    const q = quarterInfo(year, quarter as Quarter);
    const periodStart = q.periodStart.toISOString().slice(0, 10);
    const periodEnd = q.periodEnd.toISOString().slice(0, 10);
    const label = `Q${quarter}-${year}`;

    // Stored side — served as stored, whatever its date (ruling 2).
    const periodId = periodIdByLabel.get(label) ?? null;
    const storedByEmployee = new Map<string, StoredRow>();
    if (periodId) {
      const { data: stored, error: stErr } = await supabase
        .from("performance_records")
        .select("employee_id, attendance_pct")
        .eq("location_id", loc.id)
        .eq("report_period_id", periodId)
        .range(0, 9999);
      if (stErr) throw new Error(`${loc.location_code} ${label} stored: ${stErr.message}`);
      for (const r of (stored ?? []) as StoredRow[]) storedByEmployee.set(r.employee_id, r);
    }

    // Job set = active roster ∪ stored rows (existing rows still update —
    // an employee who went quiet refreshes to null; no conjuring otherwise).
    const ids = [
      ...new Set([
        ...emps.filter((e) => e.active).map((e) => e.id as string),
        ...storedByEmployee.keys(),
      ]),
    ].filter((id) => empById.has(id));

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

    const bucketCounts: Record<Bucket, number> = {
      value_changed: 0,
      null_to_value: 0,
      value_to_null: 0,
      unchanged: 0,
    };

    for (const id of ids) {
      const emp = empById.get(id)!;
      const entries = byEmployee.get(id) ?? [];
      const stored = storedByEmployee.get(id);
      const hadRow = stored !== undefined;

      // No stored row and no time entries in the window: the recompute's
      // no-conjuring rule means no row appears from the labor side. (Other
      // activity signals could still create one, but its attendance would
      // be null — invisible to this table either way.)
      if (!hadRow && entries.length === 0) continue;

      const punches = punchesTimeClockForPeriod(
        emp.punches_time_clock !== false,
        emp.punches_time_clock_since ?? null,
        periodEnd
      );
      const after = computeMetricsFromEntries(entries, {
        scheduledScoredThrough,
        punchesTimeClock: punches,
        metricsStartFloor: meta.metricsStart,
        removedShifts: evidence.get(id),
      });

      const before = hadRow ? num(stored!.attendance_pct) : null;
      const afterVal = after.attendance_pct;

      let bucket: Bucket;
      if (before === null && afterVal === null) bucket = "unchanged";
      else if (before === null) bucket = "null_to_value";
      else if (afterVal === null) bucket = "value_to_null";
      else if (Math.abs(before - afterVal) < 1e-9) bucket = "unchanged";
      else bucket = "value_changed";
      bucketCounts[bucket] += 1;

      allDiffs.push({
        store: loc.location_code as string,
        period: label,
        employee_code: emp.employee_code,
        employee_name: emp.employee_name,
        active: emp.active,
        hadRow,
        before,
        after: afterVal,
        bucket,
        schedBefore: null, // performance_records does not store counts (the §7.3 wire item)
        schedAfter: after.scheduled_count,
        attendedAfter: after.attended_count,
        wouldCreateRow: !hadRow,
      });
    }

    storeQuarterSummaries.push(
      [
        loc.location_code.padEnd(7),
        label.padEnd(8),
        String(ids.length).padStart(4),
        String(bucketCounts.value_changed).padStart(9),
        String(bucketCounts.null_to_value).padStart(9),
        String(bucketCounts.value_to_null).padStart(9),
        String(bucketCounts.unchanged).padStart(9),
      ].join("  ")
    );
  }
}

// ── report ──────────────────────────────────────────────────────────────────
console.log("\n== PER STORE × QUARTER (attendance_pct) ==");
console.log(
  ["store".padEnd(7), "period".padEnd(8), "jobs".padStart(4), "val→val'".padStart(9), "null→val".padStart(9), "val→null".padStart(9), "unchanged".padStart(9)].join("  ")
);
for (const line of storeQuarterSummaries) console.log(line);

const changed = allDiffs.filter((d) => d.bucket === "value_changed");
const rises = changed.filter((d) => d.after! > d.before!);
const falls = changed.filter((d) => d.after! < d.before!);
const nullToVal = allDiffs.filter((d) => d.bucket === "null_to_value");
const valToNull = allDiffs.filter((d) => d.bucket === "value_to_null");
const unchanged = allDiffs.filter((d) => d.bucket === "unchanged");

console.log("\n== ESTATE TOTALS ==");
console.log(`value → different value : ${changed.length}  (rises ${rises.length} / falls ${falls.length})`);
console.log(`null  → value           : ${nullToVal.length}  (of which new rows: ${nullToVal.filter((d) => d.wouldCreateRow).length})`);
console.log(`value → null            : ${valToNull.length}`);
console.log(`unchanged               : ${unchanged.length}  (of which null→null: ${unchanged.filter((d) => d.before === null).length})`);

const fmt = (v: number | null) => (v === null ? "null" : v.toFixed(2));

console.log("\n== EVERY FALL (expected direction is RISE — each of these is a finding) ==");
if (falls.length === 0) console.log("(none)");
for (const d of falls.sort((a, b) => a.after! - a.before! - (b.after! - b.before!))) {
  console.log(
    `${d.store} ${d.period} ${d.employee_code} ${d.employee_name}: ${fmt(d.before)} → ${fmt(d.after)}  (sched ${d.schedBefore} → ${d.schedAfter}, attended ${d.attendedAfter})${d.active ? "" : "  [archived]"}`
  );
}

console.log("\n== value → null (in full) ==");
if (valToNull.length === 0) console.log("(none)");
for (const d of valToNull) {
  console.log(
    `${d.store} ${d.period} ${d.employee_code} ${d.employee_name}: ${fmt(d.before)} → null  (sched ${d.schedBefore} → ${d.schedAfter})${d.active ? "" : "  [archived]"}`
  );
}

console.log("\n== null → value (in full) ==");
for (const d of nullToVal) {
  console.log(
    `${d.store} ${d.period} ${d.employee_code} ${d.employee_name}: null → ${fmt(d.after)}  (sched ${d.schedAfter}, attended ${d.attendedAfter})${d.wouldCreateRow ? "  [row created]" : ""}${d.active ? "" : "  [archived]"}`
  );
}

console.log("\n== TOP 15 RISES ==");
for (const d of rises
  .sort((a, b) => b.after! - b.before! - (a.after! - a.before!))
  .slice(0, 15)) {
  console.log(
    `${d.store} ${d.period} ${d.employee_code} ${d.employee_name}: ${fmt(d.before)} → ${fmt(d.after)}  (sched ${d.schedBefore} → ${d.schedAfter})`
  );
}


console.log(`\nrows examined: ${allDiffs.length}  (read-only run — nothing was written)`);
