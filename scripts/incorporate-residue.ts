/**
 * PACKET 10 §2 — THE RESIDUE INCORPORATION WRITE (gated; run only after the
 * named list has gone to CP and THQ per §4, and the dry-run checkpoints are
 * accepted).
 *
 * Reads the dry-run artifact (/tmp/packet10-residue-dry-run.json — the
 * exact set the partners were shown) + CP's v2 file for the authoritative
 * timestamps, then for each STOOD person-day:
 *
 *   1. asserts the vendor id is still absent from the mirror,
 *   2. INSERTs a seven_shifts_shifts row in the ingest's exact shape,
 *      with raw carrying the CP provenance (the mig 059 discipline: a
 *      claim about which system wrote a row cites raw's payload),
 *   3. recomputes the affected (employee, quarter) via the real writer,
 *   4. asserts the stored row now matches the dry-run's predicted AFTER —
 *      scheduled_count moved, attended_count and on-time untouched. A row
 *      count from the importer is NOT evidence (§2); the assertion is.
 *
 * Rows enter as MIRROR rows, never time_entries (the day-conditional rule
 * discards te-scheduled rows on feed-covered days). If a later nightly
 * tombstones them (they are, after all, absent upstream), the stamp is
 * dated AFTER the shift date, so the §3 timing gate keeps them counting —
 * the designed resilience, not an accident.
 *
 * Run:  node --env-file=.env.local scripts/incorporate-residue.ts
 */

import Module from "node:module";
import { readFileSync } from "node:fs";

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
const { recomputePerformanceForQuarter } = await import(
  "../src/lib/performance-recompute.ts"
);

const ARTIFACT = "/tmp/packet10-residue-dry-run.json";
const CSV =
  "/Users/tuckerbascom/Desktop/The Sustain Network EcoSystem/TSNGPTEcosystem/claude_ikesweeklysurveyemailschedule/Weekly Ike's Survey, Email and Schedule Import/cp-shift-last-served-2026-08-27-v2.csv";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing env");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
  ranAt: string;
  incorporationDays: Array<{
    store: string;
    date: string;
    in_time: string;
    employee_code: string;
    employee_name: string;
    uid: number;
    shift_ids: string[];
  }>;
  simRows: Array<{
    store: string;
    period: string;
    employee_code: string;
    after: { att: number | null; onTime: number | null; sched: number; attended: number };
  }>;
};
const days = artifact.incorporationDays;
console.log(`artifact ${ARTIFACT} (dry-run of ${artifact.ranAt}): ${days.length} person-days to incorporate`);
if (days.length === 0) {
  console.log("nothing to do");
  process.exit(0);
}
// Codex F6 (PR #49): the artifact is an input, not an authority — refuse a
// stale one, and re-verify each member's load-bearing preconditions LIVE
// below before any insert.
const artifactAgeH = (Date.now() - new Date(artifact.ranAt).getTime()) / 3.6e6;
if (!(artifactAgeH >= 0 && artifactAgeH < 24)) {
  throw new Error(
    `artifact is ${artifactAgeH.toFixed(1)}h old — rerun residue-incorporation-dry-run.ts first`
  );
}

// v2 authoritative rows for start/end timestamps
const csvLines = readFileSync(CSV, "utf8").trim().split("\n").slice(1);
const authByShiftId = new Map<string, { start_at: string; end_at: string; last_served: string; band: string }>();
for (const l of csvLines) {
  const c = l.split(",");
  if (c[10] === "AUTHORITATIVE") {
    authByShiftId.set(c[0], { start_at: c[5], end_at: c[6], last_served: c[7], band: c[8] });
  }
}
const isoUtc = (s: string) => s.replace(" ", "T").replace(/\+00(:?00)?$/, "Z");

const { data: locs } = await supabase
  .from("locations")
  .select("id, location_code");
const locByCode = new Map((locs ?? []).map((l) => [l.location_code as string, l.id as string]));

const nowIso = new Date().toISOString();
const writtenIds: string[] = [];

for (const d of days) {
  const locationId = locByCode.get(d.store);
  if (!locationId) throw new Error(`${d.store}: unknown location`);
  const { data: emp, error: empErr } = await supabase
    .from("employees")
    .select("id")
    .eq("employee_code", d.employee_code)
    .eq("location_id", locationId)
    .single();
  if (empErr || !emp) throw new Error(`${d.employee_code}: ${empErr?.message}`);

  // Codex F6: re-verify the residue preconditions LIVE — the artifact's
  // claims must still hold at write time. (a) at/above floor, (b) no punch
  // that day at this store, (c) no mirror shift for (uid, date) anywhere.
  {
    const { data: locRow } = await supabase
      .from("locations")
      .select("metrics_start_date")
      .eq("id", locationId)
      .single();
    const floor = locRow?.metrics_start_date as string | null;
    if (floor && d.date < floor)
      throw new Error(`${d.employee_code} ${d.date}: below ${d.store} floor ${floor}`);
    const { count: teP } = await supabase
      .from("time_entries")
      .select("*", { count: "exact", head: true })
      .eq("employee_id", emp.id)
      .eq("location_id", locationId)
      .eq("entry_date", d.date)
      .neq("entry_type", "scheduled");
    const { count: toastP } = await supabase
      .from("toast_time_entries")
      .select("*", { count: "exact", head: true })
      .eq("employee_id", emp.id)
      .eq("location_id", locationId)
      .eq("entry_date", d.date)
      .eq("deleted", false);
    if ((teP ?? 0) + (toastP ?? 0) > 0)
      throw new Error(`${d.employee_code} ${d.date}: a punch now exists — not a residue day anymore, stop`);
    const { data: others } = await supabase
      .from("seven_shifts_shifts")
      .select("seven_shifts_shift_id")
      .eq("seven_shifts_user_id", d.uid)
      .eq("entry_date", d.date);
    const foreign = (others ?? []).filter(
      (o) => !d.shift_ids.includes(String(o.seven_shifts_shift_id))
    );
    if (foreign.length > 0)
      throw new Error(`${d.employee_code} ${d.date}: mirror now holds another shift for (uid, date) — stop`);
  }

  for (const shiftId of d.shift_ids) {
    const auth = authByShiftId.get(shiftId);
    if (!auth) throw new Error(`${shiftId}: no AUTHORITATIVE v2 row`);
    if (auth.band.toLowerCase() !== "stood")
      throw new Error(`${shiftId}: band is ${auth.band}, refusing to incorporate`);

    // Codex F5: resumable, not merely guarded — a row this importer already
    // wrote (provenance in raw) is skipped and flows on to recompute +
    // assert; a row from any OTHER writer is a hard stop.
    const { data: existing } = await supabase
      .from("seven_shifts_shifts")
      .select("raw")
      .eq("seven_shifts_shift_id", Number(shiftId))
      .maybeSingle();
    if (existing) {
      const src = (existing.raw as { source?: string } | null)?.source;
      if (src === "cp_residue_incorporation") {
        console.log(`resume: ${shiftId} already imported by this importer — skipping insert`);
        writtenIds.push(shiftId);
        continue;
      }
      throw new Error(
        `${shiftId}: present in the mirror with foreign provenance (${src ?? "no raw.source"}) — stop`
      );
    }

    const { error: insErr } = await supabase.from("seven_shifts_shifts").insert({
      seven_shifts_shift_id: Number(shiftId),
      location_id: locationId,
      employee_id: emp.id,
      seven_shifts_user_id: d.uid,
      entry_date: d.date,
      start_at: isoUtc(auth.start_at),
      end_at: isoUtc(auth.end_at),
      deleted: false,
      draft: false,
      publish_status: null,
      attendance_status: null,
      late_minutes: null,
      missing_upstream_since: null,
      last_seen_upstream_at: isoUtc(auth.last_served),
      raw: {
        source: "cp_residue_incorporation",
        packet: "10 §2 (Tucker ruling 2026-08-27)",
        cp_file: "cp-shift-last-served-2026-08-27-v2.csv",
        cp_last_served_at: auth.last_served,
        band: auth.band,
        imported_at: nowIso,
        note: "CP-held vendor shift withdrawn upstream before EPD's mirror backfill (2026-08-23); stood through its date per the v2 authoritative row.",
      },
    });
    if (insErr) throw new Error(`${shiftId}: insert failed: ${insErr.message}`);
    writtenIds.push(shiftId);
    console.log(`inserted ${shiftId}  ${d.store} ${d.date} ${d.employee_code} ${d.employee_name}`);
  }

  // recompute the affected quarter with the real writer
  const y = Number(d.date.slice(0, 4));
  const q = (Math.floor((Number(d.date.slice(5, 7)) - 1) / 3) + 1) as 1 | 2 | 3 | 4;
  const r = await recomputePerformanceForQuarter(supabase, emp.id as string, locationId, y, q);
  if (!r.ok) throw new Error(`${d.employee_code} recompute failed: ${r.error}`);
  console.log(`recomputed ${d.employee_code} Q${q}-${y}: action=${r.action}`);

  // §2 assertion: the stored row must match the dry-run's predicted AFTER
  const { data: period } = await supabase
    .from("report_periods")
    .select("id")
    .eq("year", y)
    .eq("quarter", q)
    .single();
  const { data: stored } = await supabase
    .from("performance_records")
    .select("attendance_pct, on_time_grace_pct, scheduled_count, attended_count")
    .eq("employee_id", emp.id)
    .eq("report_period_id", period!.id)
    .single();
  const sim = artifact.simRows.find(
    (s) =>
      s.employee_code === d.employee_code &&
      s.store === d.store && // Codex F7: employee codes are location-scoped
      s.period === `Q${q}-${y}`
  );
  if (!sim) throw new Error(`${d.employee_code}: no simRow in artifact`);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const close = (a: number | null, b: number | null) =>
    (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) < 1e-6);
  const okSched = num(stored!.scheduled_count) === sim.after.sched;
  const okAtt = close(num(stored!.attendance_pct), sim.after.att);
  const okAttended = num(stored!.attended_count) === sim.after.attended;
  const okOnTime = close(num(stored!.on_time_grace_pct), sim.after.onTime);
  console.log(
    `ASSERT ${d.employee_code}: scheduled_count ${num(stored!.scheduled_count)}=${sim.after.sched} ${okSched ? "✓" : "⛔"} · attendance ${num(stored!.attendance_pct)?.toFixed(3)}≈${sim.after.att?.toFixed(3)} ${okAtt ? "✓" : "⛔"} · attended ${okAttended ? "✓" : "⛔"} · on-time ${okOnTime ? "✓" : "⛔"}`
  );
  if (!(okSched && okAtt && okAttended && okOnTime)) {
    throw new Error(
      `${d.employee_code}: post-write state does not match the dry-run prediction — investigate before touching anything else`
    );
  }
}

console.log(
  `\nDONE: ${writtenIds.length} mirror rows written (${writtenIds.join(", ")}), completed ${new Date().toISOString()} — this is THQ's poll-precondition timestamp.`
);
