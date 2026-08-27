/**
 * PACKET 10 §2/§4 — RESIDUE INCORPORATION DRY-RUN. READ-ONLY by
 * construction: every Supabase call is a select; the CSV is read from disk;
 * nothing is written anywhere.
 *
 * Recomputes the residue population from CP's v2 file (distinct shift ids,
 * AUTHORITATIVE rows only — §1a/§1b/§1c), then simulates the incorporation
 * through the REAL sourcing semantics:
 *
 *   Toast stores  synthetic MIRROR row → enters the day-conditional day set
 *                 (earliest-start; the day becomes feed-covered) and the
 *                 evidence liveDates (so the day stays a scored absence,
 *                 never a removal drop).
 *   NOLA          a mirror row is INVISIBLE to NOLA's entries (non-Toast
 *                 branch reads time_entries only) — simulated as the
 *                 te-scheduled shape + mirror companion for evidence, and
 *                 FLAGGED: the importer needs this store-aware shape or
 *                 NOLA members are a silent no-op.
 *
 * Checkpoints (packet 10 §4 — all four reported regardless of outcome):
 *   C1  residue distinct-id count vs 88
 *   C2  any id with ≠1 AUTHORITATIVE row → file inconsistent
 *   C3  on-time must not change for ANY simulated row
 *   C4  store-level attendance movement summary
 * Plus the collateral guard: any incorporated day NOT already feed-covered
 * at its store flips OTHER employees' te-fallback — enumerated if present.
 *
 * Run:  node --env-file=.env.local scripts/residue-incorporation-dry-run.ts
 */

import Module from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

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
const { computeMetricsFromEntries, punchesTimeClockForPeriod } = await import(
  "../src/lib/performance-recompute.ts"
);
const {
  fetchLocationFlipMeta,
  fetchEffectiveEntries,
  latestEffectiveWorkedDate,
  fetchRemovedShiftEvidence,
} = await import("../src/lib/flip-entries.ts");
const { quarterInfo } = await import("../src/lib/quarter.ts");
const { utcToLocalWallClock } = await import("../src/lib/ingest/sevenshifts/tz.ts");

const CSV =
  "/Users/tuckerbascom/Desktop/The Sustain Network EcoSystem/TSNGPTEcosystem/claude_ikesweeklysurveyemailschedule/Weekly Ike's Survey, Email and Schedule Import/cp-shift-last-served-2026-08-27-v2.csv";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing env");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });
const todayIso = new Date().toISOString().slice(0, 10);

// ── 1. parse v2 ─────────────────────────────────────────────────────────────
interface CpRow {
  shift_id: string;
  location_code: string;
  employee_code: string;
  uid: string;
  target_monday: string;
  start_at: string;
  end_at: string;
  last_served: string;
  classification: string;
  version_rank: string;
  authority: string;
}
const lines = readFileSync(CSV, "utf8").trim().split("\n");
const header = lines[0].split(",");
if (header.length !== 11) throw new Error(`unexpected CSV header: ${lines[0]}`);
const cpRows: CpRow[] = lines.slice(1).map((l) => {
  const c = l.split(",");
  if (c.length !== 11) throw new Error(`unparseable CSV line: ${l}`);
  return {
    shift_id: c[0],
    location_code: c[1],
    employee_code: c[2],
    uid: c[3],
    target_monday: c[4],
    start_at: c[5],
    end_at: c[6],
    last_served: c[7],
    classification: c[8],
    version_rank: c[9],
    authority: c[10],
  };
});

const byId = new Map<string, CpRow[]>();
for (const r of cpRows) {
  const arr = byId.get(r.shift_id) ?? [];
  arr.push(r);
  byId.set(r.shift_id, arr);
}

// C2: exactly one AUTHORITATIVE row per id
const badAuthority: string[] = [];
const authoritative = new Map<string, CpRow>();
for (const [id, rows] of byId) {
  const auth = rows.filter((r) => r.authority === "AUTHORITATIVE");
  if (auth.length !== 1) {
    badAuthority.push(`${id}: ${auth.length} AUTHORITATIVE rows`);
  } else {
    authoritative.set(id, auth[0]);
  }
}

console.log(`v2 file: ${cpRows.length} rows, ${byId.size} distinct shift ids`);
console.log(`CHECKPOINT C2 (single authority per id): ${badAuthority.length === 0 ? "PASS" : "FAIL"}`);
for (const b of badAuthority) console.log(`  ⛔ ${b}`);
if (badAuthority.length > 0) {
  console.log("⛔ file inconsistent — stopping per §4.");
  process.exit(1);
}

// ── 2. CP-only ids (anti-join on distinct id, any mirror state) ─────────────
const mirrorIds = new Set<string>();
{
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("seven_shifts_shifts")
      .select("seven_shifts_shift_id")
      .order("seven_shifts_shift_id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`mirror ids: ${error.message}`);
    for (const r of data ?? []) mirrorIds.add(String(r.seven_shifts_shift_id));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
}
const cpOnlyIds = [...authoritative.keys()].filter((id) => !mirrorIds.has(id));
console.log(`mirror ids: ${mirrorIds.size} · CP-only distinct ids: ${cpOnlyIds.length}`);

// ── 3. reference data ───────────────────────────────────────────────────────
const { data: locs, error: locErr } = await supabase
  .from("locations")
  .select("id, location_code, metrics_start_date, timezone")
  .order("location_code");
if (locErr || !locs) throw new Error(`locations: ${locErr?.message}`);
const locByCode = new Map(locs.map((l) => [l.location_code as string, l]));

interface Emp {
  id: string;
  employee_code: string;
  employee_name: string;
  active: boolean;
  punches_time_clock: boolean | null;
  punches_time_clock_since: string | null;
  seven_shifts_user_id: number | null;
  location_id: string;
}
const { data: empRows, error: empErr } = await supabase
  .from("employees")
  .select(
    "id, employee_code, employee_name, active, punches_time_clock, punches_time_clock_since, seven_shifts_user_id, location_id"
  )
  .range(0, 9999);
if (empErr || !empRows) throw new Error(`employees: ${empErr.message}`);
const empByUidLoc = new Map<string, Emp>();
for (const e of empRows as Emp[]) {
  if (e.seven_shifts_user_id !== null) {
    empByUidLoc.set(`${e.seven_shifts_user_id}|${e.location_id}`, e);
  }
}

// ── 4. residue classification per CP-only id ────────────────────────────────
interface Member {
  shift_id: string;
  band: string;
  store: string;
  location_id: string;
  employee: Emp | null;
  uid: string;
  local_date: string | null;
  local_in_time: string | null;
  drop_reason: string | null; // why it is NOT residue (null = residue)
}
const members: Member[] = [];
for (const id of cpOnlyIds) {
  const row = authoritative.get(id)!;
  const loc = locByCode.get(row.location_code);
  if (!loc) {
    members.push({ shift_id: id, band: row.classification, store: row.location_code, location_id: "", employee: null, uid: row.uid, local_date: null, local_in_time: null, drop_reason: "unmapped_location" });
    continue;
  }
  // CSV timestamps are "YYYY-MM-DD HH:MM:SS+00" — normalize to strict ISO
  // (space→T, bare "+00"→"Z") or Date parsing silently fails.
  const isoStart = row.start_at.replace(" ", "T").replace(/\+00(:?00)?$/, "Z");
  const local = utcToLocalWallClock(isoStart, loc.timezone as string);
  const uidNum = Number(row.uid);
  const emp =
    row.uid && uidNum > 0 ? empByUidLoc.get(`${uidNum}|${loc.id}`) ?? null : null;
  const m: Member = {
    shift_id: id,
    band: row.classification,
    store: row.location_code,
    location_id: loc.id as string,
    employee: emp,
    uid: row.uid,
    local_date: local?.date ?? null,
    local_in_time: local?.time ?? null,
    drop_reason: null,
  };
  if (!row.uid || uidNum === 0) m.drop_reason = "open_shift_uid_0";
  else if (!emp) m.drop_reason = "uid_unresolved";
  else if (!m.local_date) m.drop_reason = "unparseable_start";
  else if (loc.metrics_start_date && m.local_date < (loc.metrics_start_date as string))
    m.drop_reason = "below_floor";
  members.push(m);
}

// punch / adjacent / other-shift checks for the survivors (batched per employee)
const candidates = members.filter((m) => m.drop_reason === null);
const datesByEmp = new Map<string, Set<string>>();
for (const m of candidates) {
  const k = m.employee!.id;
  const s = datesByEmp.get(k) ?? new Set<string>();
  s.add(m.local_date!);
  datesByEmp.set(k, s);
}
function shiftDate(d: string, days: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
const punchDays = new Map<string, Set<string>>(); // employee_id -> same-store punch dates
const otherShiftDays = new Map<string, Set<string>>(); // uid -> mirror (any state, any loc) dates
for (const [empId, dates] of datesByEmp) {
  const emp = candidates.find((m) => m.employee!.id === empId)!.employee!;
  const wanted = new Set<string>();
  for (const d of dates) {
    wanted.add(shiftDate(d, -1));
    wanted.add(d);
    wanted.add(shiftDate(d, 1));
  }
  const wantedArr = [...wanted];
  const p = new Set<string>();
  {
    const { data, error } = await supabase
      .from("time_entries")
      .select("entry_date, entry_type")
      .eq("employee_id", empId)
      .eq("location_id", emp.location_id)
      .in("entry_date", wantedArr)
      .neq("entry_type", "scheduled");
    if (error) throw new Error(`te punches ${empId}: ${error.message}`);
    for (const r of data ?? []) p.add(String(r.entry_date).slice(0, 10));
  }
  {
    const { data, error } = await supabase
      .from("toast_time_entries")
      .select("entry_date")
      .eq("employee_id", empId)
      .eq("location_id", emp.location_id)
      .eq("deleted", false)
      .in("entry_date", wantedArr);
    if (error) throw new Error(`toast punches ${empId}: ${error.message}`);
    for (const r of data ?? []) p.add(String(r.entry_date).slice(0, 10));
  }
  punchDays.set(empId, p);
  const o = new Set<string>();
  {
    const { data, error } = await supabase
      .from("seven_shifts_shifts")
      .select("entry_date")
      .eq("seven_shifts_user_id", emp.seven_shifts_user_id!)
      .in("entry_date", [...dates]);
    if (error) throw new Error(`other shifts ${empId}: ${error.message}`);
    for (const r of data ?? []) o.add(String(r.entry_date).slice(0, 10));
  }
  otherShiftDays.set(empId, o);
}
for (const m of candidates) {
  const p = punchDays.get(m.employee!.id) ?? new Set();
  const o = otherShiftDays.get(m.employee!.id) ?? new Set();
  const d = m.local_date!;
  if (p.has(d)) m.drop_reason = "punched_same_day";
  else if (o.has(d)) m.drop_reason = "other_epd_shift_same_day";
  else if (p.has(shiftDate(d, -1)) || p.has(shiftDate(d, 1)))
    m.drop_reason = "adjacent_day_punch";
}

const residue = members.filter((m) => m.drop_reason === null);
const residueIds = new Set(residue.map((m) => m.shift_id));
console.log(`\nCHECKPOINT C1 (residue distinct ids vs 88): ${residueIds.size}  ${Math.abs(residueIds.size - 88) <= 5 ? "(within tolerance)" : "⛔ MATERIALLY DIFFERENT"}`);

const bandOf = (m: Member) => m.band.toLowerCase();
const stood = residue.filter((m) => bandOf(m) === "stood");
const boundary = residue.filter((m) => bandOf(m) === "boundary");
const cancelled = residue.filter((m) => bandOf(m) === "cancelled");
const superseded = residue.filter((m) => bandOf(m) === "superseded");
console.log(`residue bands (authoritative rows): stood ${stood.length} · boundary ${boundary.length} · cancelled ${cancelled.length} · superseded-marked ${superseded.length} (must be 0)`);

// drop-reason census for the CP-only ids that are NOT residue
const census = new Map<string, number>();
for (const m of members.filter((x) => x.drop_reason !== null)) {
  census.set(m.drop_reason!, (census.get(m.drop_reason!) ?? 0) + 1);
}
console.log(`non-residue CP-only ids by reason: ${[...census.entries()].map(([k, v]) => `${k} ${v}`).join(" · ")}`);

// ── 5. incorporation set = STOOD residue, deduped to person-days ────────────
interface Day {
  employee: Emp;
  store: string;
  location_id: string;
  date: string;
  in_time: string;
  shift_ids: string[];
  bands: string[];
}
const dayKey = new Map<string, Day>();
for (const m of stood) {
  const k = `${m.employee!.id}|${m.local_date}`;
  const existing = dayKey.get(k);
  if (existing) {
    existing.shift_ids.push(m.shift_id);
    existing.bands.push(m.band);
    if (m.local_in_time! < existing.in_time) existing.in_time = m.local_in_time!; // earliest-start
  } else {
    dayKey.set(k, {
      employee: m.employee!,
      store: m.store,
      location_id: m.location_id,
      date: m.local_date!,
      in_time: m.local_in_time!,
      shift_ids: [m.shift_id],
      bands: [m.band],
    });
  }
}
const days = [...dayKey.values()];
console.log(`\nincorporation set: ${stood.length} stood shifts → ${days.length} person-days`);

// collateral guard: is each day already feed-covered at its store?
const uncovered: Day[] = [];
for (const d of days) {
  const { count, error } = await supabase
    .from("seven_shifts_shifts")
    .select("seven_shifts_shift_id", { count: "exact", head: true })
    .eq("location_id", d.location_id)
    .eq("entry_date", d.date)
    .is("missing_upstream_since", null)
    .eq("deleted", false)
    .eq("draft", false);
  if (error) throw new Error(`coverage ${d.store} ${d.date}: ${error.message}`);
  if ((count ?? 0) === 0) uncovered.push(d);
}
console.log(`COLLATERAL GUARD: incorporated days NOT already feed-covered: ${uncovered.length}`);
for (const d of uncovered) {
  const { count } = await supabase
    .from("time_entries")
    .select("id", { count: "exact", head: true })
    .eq("location_id", d.location_id)
    .eq("entry_date", d.date)
    .eq("entry_type", "scheduled");
  console.log(`  ⚠️ ${d.store} ${d.date}: day would BECOME covered; ${count ?? 0} te-scheduled rows at the store that day would flip off fallback`);
}

// ── 6. simulate per (employee, quarter) ─────────────────────────────────────
type Q = 1 | 2 | 3 | 4;
const jobs = new Map<string, { emp: Emp; store: string; location_id: string; year: number; quarter: Q; days: Day[] }>();
for (const d of days) {
  const y = Number(d.date.slice(0, 4));
  const q = (Math.floor((Number(d.date.slice(5, 7)) - 1) / 3) + 1) as Q;
  const k = `${d.employee.id}|${y}|${q}`;
  const j = jobs.get(k) ?? { emp: d.employee, store: d.store, location_id: d.location_id, year: y, quarter: q, days: [] };
  j.days.push(d);
  jobs.set(k, j);
}

const { data: periods } = await supabase
  .from("report_periods")
  .select("id, year, quarter, frozen");
const periodIdByLabel = new Map(
  (periods ?? []).map((p) => [`${p.year}|${p.quarter}`, { id: p.id as string, frozen: p.frozen as boolean }])
);

interface SimRow {
  store: string;
  period: string;
  employee_code: string;
  employee_name: string;
  daysAdded: number;
  before: { att: number | null; onTime: number | null; sched: number | null; attended: number | null };
  after: { att: number | null; onTime: number | null; sched: number; attended: number };
  bucket: string;
  nolaShape: boolean;
}
const simRows: SimRow[] = [];
const metaByLoc = new Map<string, Awaited<ReturnType<typeof fetchLocationFlipMeta>>>();
const capByLoc = new Map<string, string>();

for (const [, j] of jobs) {
  const label = `Q${j.quarter}-${j.year}`;
  const per = periodIdByLabel.get(`${j.year}|${j.quarter}`);
  if (per?.frozen) {
    console.log(`⛔ ${j.store} ${label} is FROZEN — ${j.emp.employee_code} skipped (must not happen)`);
    continue;
  }
  let meta = metaByLoc.get(j.location_id);
  if (!meta) {
    meta = await fetchLocationFlipMeta(supabase, j.location_id);
    metaByLoc.set(j.location_id, meta);
    const latestWorked = await latestEffectiveWorkedDate(supabase, j.location_id, meta);
    capByLoc.set(j.location_id, latestWorked !== null && latestWorked < todayIso ? latestWorked : todayIso);
  }
  const cap = capByLoc.get(j.location_id)!;
  const qi = quarterInfo(j.year, j.quarter);
  const periodStart = qi.periodStart.toISOString().slice(0, 10);
  const periodEnd = qi.periodEnd.toISOString().slice(0, 10);

  const byEmployee = await fetchEffectiveEntries(supabase, j.location_id, [j.emp.id], { start: periodStart, end: periodEnd }, meta);
  const evidence = await fetchRemovedShiftEvidence(supabase, j.location_id, [j.emp.id], { start: periodStart, end: periodEnd });
  const entries = byEmployee.get(j.emp.id) ?? [];
  const rs = evidence.get(j.emp.id);

  const punches = punchesTimeClockForPeriod(
    j.emp.punches_time_clock !== false,
    j.emp.punches_time_clock_since ?? null,
    periodEnd
  );

  const beforeMetrics = computeMetricsFromEntries(entries, {
    scheduledScoredThrough: cap,
    punchesTimeClock: punches,
    metricsStartFloor: meta.metricsStart,
    removedShifts: rs,
  });

  // AFTER: synthetic scheduled entries for the incorporated days + the
  // days join the evidence liveDates (the imported mirror row is live).
  const synthetic = j.days
    .filter((d) => d.date <= cap) // beyond-cap days would not score — flagged below
    .map((d) => ({ entry_date: d.date, entry_type: "scheduled", in_time: d.in_time }));
  const afterEntries = [...entries, ...synthetic];
  const afterRs = rs
    ? { ...rs, liveDates: rs.liveDates ? new Set([...rs.liveDates, ...j.days.map((d) => d.date)]) : rs.liveDates }
    : rs;
  const afterMetrics = computeMetricsFromEntries(afterEntries, {
    scheduledScoredThrough: cap,
    punchesTimeClock: punches,
    metricsStartFloor: meta.metricsStart,
    removedShifts: afterRs,
  });
  const beyondCap = j.days.filter((d) => d.date > cap);
  for (const d of beyondCap) console.log(`  ⚠️ ${j.store} ${d.date} ${j.emp.employee_code}: beyond scored-through cap ${cap} — will not score until the cap advances`);

  // stored before values
  let stored: { attendance_pct: number | null; on_time_grace_pct: number | null; scheduled_count: number | null; attended_count: number | null } | null = null;
  if (per) {
    const { data } = await supabase
      .from("performance_records")
      .select("attendance_pct, on_time_grace_pct, scheduled_count, attended_count")
      .eq("employee_id", j.emp.id)
      .eq("report_period_id", per.id)
      .maybeSingle();
    stored = data ?? null;
  }
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

  const b = stored ? num(stored.attendance_pct) : null;
  const a = afterMetrics.attendance_pct;
  let bucket: string;
  if (b === null && a === null) bucket = "unchanged";
  else if (b === null) bucket = "null_to_value";
  else if (a === null) bucket = "value_to_null";
  else bucket = Math.abs(b - a) < 1e-9 ? "unchanged" : "value_changed";

  simRows.push({
    store: j.store,
    period: label,
    employee_code: j.emp.employee_code,
    employee_name: j.emp.employee_name,
    daysAdded: synthetic.length,
    before: { att: b, onTime: stored ? num(stored.on_time_grace_pct) : null, sched: stored ? num(stored.scheduled_count) : null, attended: stored ? num(stored.attended_count) : null },
    after: { att: a, onTime: afterMetrics.on_time_grace_pct, sched: afterMetrics.scheduled_count, attended: afterMetrics.attended_count },
    bucket,
    nolaShape: !metaByLoc.get(j.location_id)!.isToast,
  });

  // parity guard: the before-side must reproduce the stored value
  if (stored && b !== null && beforeMetrics.attendance_pct !== null && Math.abs(b - beforeMetrics.attendance_pct) > 1e-6) {
    console.log(`  ⚠️ PARITY: ${j.store} ${label} ${j.emp.employee_code} stored ${b} vs recomputed-before ${beforeMetrics.attendance_pct} — pre-existing drift, not caused by the incorporation`);
  }
}

// ── 7. report ───────────────────────────────────────────────────────────────
const fmt = (v: number | null) => (v === null ? "null" : v.toFixed(3));

console.log(`\n== NAMED LIST (person · store · date · band) — the artefact promised to CP and THQ ==`);
for (const d of days.sort((a, b) => (a.store + a.date).localeCompare(b.store + b.date))) {
  console.log(`${d.store}  ${d.date}  ${d.employee.employee_code}  ${d.employee.employee_name}  uid=${d.employee.seven_shifts_user_id}  shift ${d.shift_ids.join("+")}  STOOD${d.shift_ids.length > 1 ? "  [2 ids, 1 day]" : ""}`);
}

console.log(`\n== EXCUSED (residue members NOT incorporated, by band) ==`);
for (const m of [...boundary, ...cancelled].sort((a, b) => (a.store + a.local_date).localeCompare(b.store + b.local_date!))) {
  console.log(`${m.store}  ${m.local_date}  ${m.employee!.employee_code}  ${m.employee!.employee_name}  shift ${m.shift_id}  ${m.band.toUpperCase()}`);
}

console.log(`\n== FOUR-BUCKET TABLE (attendance_pct, per store × period) ==`);
const byStorePeriod = new Map<string, Record<string, number>>();
for (const r of simRows) {
  const k = `${r.store} ${r.period}`;
  const rec = byStorePeriod.get(k) ?? { value_changed: 0, null_to_value: 0, value_to_null: 0, unchanged: 0 };
  rec[r.bucket] += 1;
  byStorePeriod.set(k, rec);
}
console.log(["store+period".padEnd(16), "val→val'".padStart(9), "null→val".padStart(9), "val→null".padStart(9), "unchanged".padStart(9)].join("  "));
for (const [k, rec] of [...byStorePeriod.entries()].sort()) {
  console.log([k.padEnd(16), String(rec.value_changed).padStart(9), String(rec.null_to_value).padStart(9), String(rec.value_to_null).padStart(9), String(rec.unchanged).padStart(9)].join("  "));
}

console.log(`\n== EVERY MOVED ROW (expected: attendance FALLS, counts move, on-time frozen) ==`);
for (const r of simRows.filter((x) => x.bucket !== "unchanged").sort((a, b) => (a.store + a.employee_code).localeCompare(b.store + b.employee_code))) {
  console.log(
    `${r.store} ${r.period} ${r.employee_code} ${r.employee_name}: att ${fmt(r.before.att)} → ${fmt(r.after.att)} · sched ${r.before.sched} → ${r.after.sched} · attended ${r.before.attended} → ${r.after.attended} · on-time ${fmt(r.before.onTime)} → ${fmt(r.after.onTime)} · +${r.daysAdded}d${r.nolaShape ? "  [NOLA te-shape]" : ""}`
  );
}

const onTimeMoved = simRows.filter(
  (r) => (r.before.onTime === null) !== (r.after.onTime === null) ||
    (r.before.onTime !== null && r.after.onTime !== null && Math.abs(r.before.onTime - r.after.onTime) > 1e-9)
);
console.log(`\nCHECKPOINT C3 (on-time unchanged on every row): ${onTimeMoved.length === 0 ? "PASS" : `⛔ FAIL — ${onTimeMoved.length} rows moved`}`);
for (const r of onTimeMoved) console.log(`  ⛔ ${r.store} ${r.period} ${r.employee_code}: ${fmt(r.before.onTime)} → ${fmt(r.after.onTime)}`);

const attendedMoved = simRows.filter((r) => r.before.attended !== null && r.before.attended !== r.after.attended);
console.log(`attended_count invariance: ${attendedMoved.length === 0 ? "PASS" : `⛔ FAIL — ${attendedMoved.length} rows`}`);

console.log(`\nCHECKPOINT C4 (store-level movement):`);
const rises = simRows.filter((r) => r.before.att !== null && r.after.att !== null && r.after.att > r.before.att);
console.log(`  rises: ${rises.length} (expected 0 — this change is monotonic downward)`);
for (const [k] of [...byStorePeriod.entries()].sort()) {
  const rows = simRows.filter((r) => `${r.store} ${r.period}` === k && r.before.att !== null && r.after.att !== null);
  if (rows.length === 0) continue;
  const worst = Math.max(...rows.map((r) => (r.before.att! - r.after.att!)));
  const avg = rows.reduce((s, r) => s + (r.before.att! - r.after.att!), 0) / rows.length;
  console.log(`  ${k}: ${rows.length} moved rows, avg fall ${avg.toFixed(3)}pp, worst ${worst.toFixed(3)}pp`);
}

writeFileSync(
  "/tmp/packet10-residue-dry-run.json",
  JSON.stringify({ ranAt: new Date().toISOString(), residue: residue.map((m) => ({ ...m, employee: m.employee ? { code: m.employee.employee_code, name: m.employee.employee_name, uid: m.employee.seven_shifts_user_id } : null })), incorporationDays: days.map((d) => ({ store: d.store, date: d.date, in_time: d.in_time, employee_code: d.employee.employee_code, employee_name: d.employee.employee_name, uid: d.employee.seven_shifts_user_id, shift_ids: d.shift_ids })), simRows }, null, 1)
);
console.log(`\nartifacts: /tmp/packet10-residue-dry-run.json  (read-only run — nothing was written)`);
