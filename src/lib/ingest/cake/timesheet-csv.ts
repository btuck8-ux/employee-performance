/**
 * CAKE timesheet CSV -> EPD `time_entries` (entry_type 'worked').
 *
 * WHY THIS EXISTS: NOLA's worked actuals come from CAKE, not 7shifts
 * (locations.actuals_source = 'cake'), so the nightly 7shifts_time pull skips
 * it. Until the CAKE *Labor API* feed is live, NOLA labor is loaded from a
 * manual CAKE timesheet export. This module is the durable, idempotent,
 * replayable loader for that export — the CAKE analog of sevenshifts/time.ts.
 *
 * JOIN KEY: every CAKE row carries a `cake_profile_id` (the CAKE "userId").
 * We map profile_id -> EPD employee via `cake_profile_crosswalk`, NEVER by
 * name — CAKE's stored name can disagree with the EPD roster (e.g. CAKE
 * "Tolson" vs roster "Tolan"), and one employee may own two profile ids.
 * Any profile id not in the crosswalk is SURFACED in the outcome detail,
 * never silently dropped.
 *
 * COLLAPSE: multiple shifts for one (employee, business date) collapse to one
 * row — earliest in, latest out, hours/pay summed — matching sevenshifts/time.ts
 * and the manual time-entries-import collapse, which is what the unique key
 * (employee_id, entry_date, entry_type) on time_entries requires.
 *
 * The CSV is produced by the CAKE-portal harvester (a manual export, or the
 * staff.cake.net `getShifts` pull projected to local Chicago wall-clock). The
 * expected header is the canonical schema below; common header aliases are
 * accepted so a raw CAKE export can be fed with minimal massaging.
 */

import Papa from "papaparse";

/** profile_id -> EPD identity, from cake_profile_crosswalk. */
export interface CakeProfile {
  employee_id: string;
  location_id: string;
  employee_code: string;
  full_name: string;
}

/** One collapsed worked day, ready to upsert into time_entries. */
export interface CakeTimeEntry {
  employee_id: string;
  location_id: string;
  entry_date: string; // YYYY-MM-DD (CAKE business/local date)
  in_time: string | null; // HH:MM:SS
  out_time: string | null; // HH:MM:SS
  role: string | null;
  wage: number | null;
  regular_hours: number;
  regular_pay: number;
}

export interface ParsedCakeImport {
  rows_in_file: number;
  rows_in_window: number;
  unique_days: number;
  records: CakeTimeEntry[];
  /** profile ids present in the CSV but absent from the crosswalk. */
  unmapped_profile_ids: number[];
  /** profile ids in the CSV whose rows were all open/invalid. */
  warnings: string[];
}

const HEADER_ALIASES: Record<string, string> = {
  cakeprofileid: "cake_profile_id",
  profileid: "cake_profile_id",
  userid: "cake_profile_id",
  businessdate: "business_date",
  date: "business_date",
  clockindate: "business_date",
  clockin: "clock_in",
  intime: "clock_in",
  timein: "clock_in",
  clockout: "clock_out",
  outtime: "clock_out",
  timeout: "clock_out",
  paidhours: "paid_hours",
  hours: "paid_hours",
  hourlyrate: "hourly_rate",
  rate: "hourly_rate",
  wage: "hourly_rate",
  jobtitle: "job_title",
  job: "job_title",
  role: "job_title",
  assignment: "job_title",
};

function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** "9:23 AM", "16:00:21", "22:32" -> "HH:MM:SS" (24h). null if unparseable. */
export function parseClock(input: string | undefined | null): string | null {
  if (!input) return null;
  const cleaned = String(input).trim().toUpperCase();
  if (!cleaned || cleaned === "-") return null;
  const ampm = cleaned.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = parseInt(ampm[2], 10);
    const s = ampm[3] ? parseInt(ampm[3], 10) : 0;
    if (ampm[4] === "PM" && h !== 12) h += 12;
    if (ampm[4] === "AM" && h === 12) h = 0;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }
  const h24 = cleaned.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (h24) {
    const h = parseInt(h24[1], 10);
    const m = parseInt(h24[2], 10);
    const s = h24[3] ? parseInt(h24[3], 10) : 0;
    if (h > 23 || m > 59 || s > 59) return null;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }
  return null;
}

function num(input: string | undefined): number {
  if (!input) return 0;
  const n = Number(String(input).trim().replace(/[$,]/g, ""));
  return Number.isNaN(n) ? 0 : n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Parse a CAKE timesheet CSV and collapse to one worked row per
 * (employee, business date), mapping cake_profile_id -> employee via the
 * supplied crosswalk. Rows outside [windowStart, windowEnd] (inclusive,
 * YYYY-MM-DD) are skipped. Rows with no clock_out are treated as open and
 * skipped (not a finalized actual), mirroring sevenshifts/time.ts.
 */
export function parseCakeTimesheetCsv(
  csvText: string,
  crosswalk: Map<number, CakeProfile>,
  opts?: { windowStart?: string; windowEnd?: string }
): ParsedCakeImport {
  const result: ParsedCakeImport = {
    rows_in_file: 0,
    rows_in_window: 0,
    unique_days: 0,
    records: [],
    unmapped_profile_ids: [],
    warnings: [],
  };

  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  const rows = parsed.data;
  result.rows_in_file = rows.length;
  if (rows.length === 0) {
    result.warnings.push("CSV is empty.");
    return result;
  }

  const headerMap: Record<string, string> = {};
  for (const raw of parsed.meta.fields ?? []) {
    const canonical = HEADER_ALIASES[normalizeHeader(raw)];
    if (canonical) headerMap[raw] = canonical;
  }
  const field = (row: Record<string, string>, canon: string): string | undefined => {
    for (const [raw, c] of Object.entries(headerMap)) {
      if (c === canon) {
        const v = row[raw];
        if (v !== undefined && v !== null && String(v) !== "") return String(v).trim();
      }
    }
    return undefined;
  };

  const winStart = opts?.windowStart;
  const winEnd = opts?.windowEnd;
  const unmapped = new Set<number>();
  const groups = new Map<string, CakeTimeEntry>();

  for (const row of rows) {
    const pidRaw = field(row, "cake_profile_id");
    const date = field(row, "business_date");
    if (!pidRaw || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (winStart && date < winStart) continue;
    if (winEnd && date > winEnd) continue;

    const profile_id = parseInt(pidRaw, 10);
    const ident = crosswalk.get(profile_id);
    if (!ident) {
      unmapped.add(profile_id);
      continue;
    }

    const inTime = parseClock(field(row, "clock_in"));
    const outTime = parseClock(field(row, "clock_out"));
    if (!outTime) {
      // Open / in-progress shift — not a finalized actual yet.
      continue;
    }
    result.rows_in_window += 1;

    const hours = num(field(row, "paid_hours"));
    const wageRaw = field(row, "hourly_rate");
    const wage = wageRaw ? num(wageRaw) : null;
    const role = field(row, "job_title") ?? null;
    const pay = wage != null ? wage * hours : 0;

    const key = `${ident.employee_id}|${date}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        employee_id: ident.employee_id,
        location_id: ident.location_id,
        entry_date: date,
        in_time: inTime,
        out_time: outTime,
        role,
        wage,
        regular_hours: hours,
        regular_pay: pay,
      });
    } else {
      if (inTime && (!existing.in_time || inTime < existing.in_time)) existing.in_time = inTime;
      if (outTime && (!existing.out_time || outTime > existing.out_time)) existing.out_time = outTime;
      existing.regular_hours += hours;
      existing.regular_pay += pay;
      // role = the longest single shift's job; keep wage if not yet set.
      if (hours > 0 && (existing.role == null || hours > existing.regular_hours - hours)) {
        existing.role = role ?? existing.role;
      }
      if (existing.wage == null && wage != null) existing.wage = wage;
    }
  }

  for (const g of groups.values()) {
    g.regular_hours = round2(g.regular_hours);
    g.regular_pay = round2(g.regular_pay);
  }

  result.records = Array.from(groups.values());
  result.unique_days = result.records.length;
  result.unmapped_profile_ids = Array.from(unmapped).sort((a, b) => a - b);
  return result;
}
