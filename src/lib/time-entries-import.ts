import Papa from "papaparse";

/**
 * Parsed and collapsed time entry: one per (employee_name_key, date).
 * Multiple source rows for the same person on the same day collapse to
 * earliest-in / latest-out, with hours/pay summed.
 */
export interface ParsedTimeEntry {
  employee_name_key: string; // lowercase trimmed full name
  employee_name_display: string; // first-occurrence-cased form for error messages
  entry_date: string;            // YYYY-MM-DD
  in_time: string | null;        // HH:MM:SS (24h)
  out_time: string | null;       // HH:MM:SS (24h)
  role: string | null;
  wage: number | null;
  regular_hours: number;
  ot_hours: number;
  double_ot_hours: number;
  holiday_hours: number;
  regular_pay: number;
  ot_pay: number;
  double_ot_pay: number;
  holiday_pay: number;
  total_pay: number;
  /** Captured Location/Store/Site value from the row, for cross-location filtering. */
  location_label: string | null;
}

export interface ParsedTimeImport {
  rows_in_file: number;
  unique_shifts: number;
  warnings: string[];
  errors: string[];
  records: ParsedTimeEntry[];
}

const HEADER_ALIASES: Record<string, string> = {
  // Employee identification
  first: "first_name",
  firstname: "first_name",
  fname: "first_name",
  given: "first_name",
  givenname: "first_name",
  last: "last_name",
  lastname: "last_name",
  surname: "last_name",
  lname: "last_name",
  family: "last_name",
  familyname: "last_name",
  name: "full_name",
  fullname: "full_name",
  employeename: "full_name",

  // Date
  date: "date",
  shiftdate: "date",
  workdate: "date",

  // Times
  intime: "in_time",
  punchin: "in_time",
  starttime: "in_time",
  start: "in_time",
  outtime: "out_time",
  punchout: "out_time",
  endtime: "out_time",
  end: "out_time",

  // Role / wage
  role: "role",
  position: "role",
  jobrole: "role",
  wage: "wage",
  payrate: "wage",
  rate: "wage",

  // Hours
  regularhours: "regular_hours",
  reghours: "regular_hours",
  hours: "regular_hours",
  othours: "ot_hours",
  overtimehours: "ot_hours",
  doubleothours: "double_ot_hours",
  doubleovertimehours: "double_ot_hours",
  holidayhours: "holiday_hours",

  // Pay
  regularpay: "regular_pay",
  regpay: "regular_pay",
  otpay: "ot_pay",
  overtimepay: "ot_pay",
  doubleotpay: "double_ot_pay",
  doubleovertimepay: "double_ot_pay",
  holidaypay: "holiday_pay",
  totalpay: "total_pay",

  // Location label — for cross-location filtering of all-locations exports.
  location: "location_label",
  store: "location_label",
  storename: "location_label",
  site: "location_label",
  sitename: "location_label",
};

const SILENTLY_IGNORED_HEADERS = new Set([
  "employeeid",
  "empid",
  "employeeno",
  "punchid",
]);

function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getField(
  row: Record<string, string>,
  canonical: string,
  headerMap: Record<string, string>
): string | undefined {
  for (const [rawHeader, canonField] of Object.entries(headerMap)) {
    if (canonField === canonical) {
      const value = row[rawHeader];
      if (value !== undefined && value !== null && value !== "")
        return String(value).trim();
    }
  }
  return undefined;
}

/**
 * Parse a time string like "2:56PM", " 8:20PM", "11:00AM", "9:00", "14:30"
 * into "HH:MM:SS" 24-hour format. Returns null if unparseable.
 */
export function parseTimeOfDay(input: string | undefined | null): string | null {
  if (!input) return null;
  const cleaned = input.trim().toUpperCase();
  if (!cleaned) return null;

  // 12-hour with AM/PM
  const ampmMatch = cleaned.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (ampmMatch) {
    let h = parseInt(ampmMatch[1], 10);
    const m = parseInt(ampmMatch[2], 10);
    const s = ampmMatch[3] ? parseInt(ampmMatch[3], 10) : 0;
    const meridiem = ampmMatch[4];
    if (meridiem === "PM" && h !== 12) h += 12;
    if (meridiem === "AM" && h === 12) h = 0;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }

  // 24-hour HH:MM[:SS]
  const h24Match = cleaned.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (h24Match) {
    const h = parseInt(h24Match[1], 10);
    const m = parseInt(h24Match[2], 10);
    const s = h24Match[3] ? parseInt(h24Match[3], 10) : 0;
    if (h > 23 || m > 59 || s > 59) return null;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }

  return null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function parseNumber(input: string | undefined): number {
  if (!input) return 0;
  const cleaned = input.trim().replace(/[$,]/g, "");
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Parse a CSV (worked or scheduled — same schema) and return collapsed
 * one-per-(employee, date) entries with earliest-in / latest-out.
 */
export function parseTimeEntriesCsv(csvText: string): ParsedTimeImport {
  const result: ParsedTimeImport = {
    rows_in_file: 0,
    unique_shifts: 0,
    warnings: [],
    errors: [],
    records: [],
  };

  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) {
      result.errors.push(`Row ${err.row ?? "?"}: ${err.message}`);
    }
  }

  const rows = parsed.data;
  result.rows_in_file = rows.length;
  if (rows.length === 0) {
    result.errors.push("CSV is empty.");
    return result;
  }

  const rawHeaders = parsed.meta.fields ?? [];
  const headerMap: Record<string, string> = {};
  const unmatched: string[] = [];
  for (const raw of rawHeaders) {
    const normalized = normalizeHeader(raw);
    const canonical = HEADER_ALIASES[normalized];
    if (canonical) headerMap[raw] = canonical;
    else if (!SILENTLY_IGNORED_HEADERS.has(normalized)) unmatched.push(raw);
  }
  if (unmatched.length > 0) {
    result.warnings.push(
      `Ignored ${unmatched.length} unrecognized column${unmatched.length === 1 ? "" : "s"}: ${unmatched.join(", ")}`
    );
  }

  // Sanity check on minimum columns
  const canon = new Set(Object.values(headerMap));
  if (!canon.has("date") || (!canon.has("first_name") && !canon.has("full_name"))) {
    result.errors.push(
      "Missing required columns. Expected at least: Date and (First name + Last name) or Name."
    );
    return result;
  }

  // Collapse by (employee, date)
  const groups = new Map<string, ParsedTimeEntry>();

  for (const row of rows) {
    const first = getField(row, "first_name", headerMap) ?? "";
    const last = getField(row, "last_name", headerMap) ?? "";
    const full = getField(row, "full_name", headerMap) ?? "";
    const displayName = full || `${first} ${last}`.trim();
    if (!displayName) continue;

    const dateRaw = getField(row, "date", headerMap);
    if (!dateRaw || !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      result.warnings.push(`Skipped row with invalid date "${dateRaw ?? ""}" for ${displayName}.`);
      continue;
    }

    const inTime = parseTimeOfDay(getField(row, "in_time", headerMap));
    const outTime = parseTimeOfDay(getField(row, "out_time", headerMap));

    const role = getField(row, "role", headerMap) ?? null;
    const wageRaw = getField(row, "wage", headerMap);
    const wage = wageRaw ? parseNumber(wageRaw) : null;

    const reg = parseNumber(getField(row, "regular_hours", headerMap));
    const ot = parseNumber(getField(row, "ot_hours", headerMap));
    const dot = parseNumber(getField(row, "double_ot_hours", headerMap));
    const hol = parseNumber(getField(row, "holiday_hours", headerMap));
    const regPay = parseNumber(getField(row, "regular_pay", headerMap));
    const otPay = parseNumber(getField(row, "ot_pay", headerMap));
    const dotPay = parseNumber(getField(row, "double_ot_pay", headerMap));
    const holPay = parseNumber(getField(row, "holiday_pay", headerMap));
    const totalPay = parseNumber(getField(row, "total_pay", headerMap));
    const locationLabel = getField(row, "location_label", headerMap) ?? null;

    const employeeKey = displayName.toLowerCase();
    const dedupeKey = `${employeeKey}|${dateRaw}`;
    const existing = groups.get(dedupeKey);

    if (!existing) {
      groups.set(dedupeKey, {
        employee_name_key: employeeKey,
        employee_name_display: displayName,
        entry_date: dateRaw,
        in_time: inTime,
        out_time: outTime,
        role,
        wage,
        regular_hours: reg,
        ot_hours: ot,
        double_ot_hours: dot,
        holiday_hours: hol,
        regular_pay: regPay,
        ot_pay: otPay,
        double_ot_pay: dotPay,
        holiday_pay: holPay,
        total_pay: totalPay,
        location_label: locationLabel,
      });
    } else {
      // Earliest in, latest out
      if (inTime && (!existing.in_time || inTime < existing.in_time)) {
        existing.in_time = inTime;
      }
      if (outTime && (!existing.out_time || outTime > existing.out_time)) {
        existing.out_time = outTime;
      }
      // Sum the hours and pay across split shifts
      existing.regular_hours += reg;
      existing.ot_hours += ot;
      existing.double_ot_hours += dot;
      existing.holiday_hours += hol;
      existing.regular_pay += regPay;
      existing.ot_pay += otPay;
      existing.double_ot_pay += dotPay;
      existing.holiday_pay += holPay;
      existing.total_pay += totalPay;
      // Keep the first role/wage/location seen (split shifts agree on these)
      if (!existing.location_label && locationLabel) existing.location_label = locationLabel;
    }
  }

  result.records = Array.from(groups.values());
  result.unique_shifts = result.records.length;
  return result;
}
