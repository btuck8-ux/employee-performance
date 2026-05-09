import Papa from "papaparse";

export interface ParsedEmployee {
  employee_name: string;
  email: string | null;
  phone: string | null;
  hire_date: string | null;
  wage: number | null;
  wage_pay_type: string | null;
  /**
   * Captured Location/Store/Site value from the CSV row, if present. Used by
   * the upload action to filter all-locations exports down to rows that
   * belong to the target location. Null if the CSV had no location column or
   * the row's value was empty.
   */
  location_label: string | null;
}

export interface ImportResult {
  rows_in_file: number;
  active_rows: number;
  inactive_skipped: number;
  unique_employees: number;
  warnings: string[];
  errors: string[];
  records: ParsedEmployee[];
}

function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const HEADER_ALIASES: Record<string, string> = {
  // First name
  first: "first_name",
  firstname: "first_name",
  firstnames: "first_name",
  fname: "first_name",
  given: "first_name",
  givenname: "first_name",

  // Last name
  last: "last_name",
  lastname: "last_name",
  surname: "last_name",
  lname: "last_name",
  family: "last_name",
  familyname: "last_name",

  // Combined name (some exports use one column)
  name: "full_name",
  fullname: "full_name",
  employeename: "full_name",

  // Hire date
  hiredate: "hire_date",
  startdate: "hire_date",
  datehired: "hire_date",
  hired: "hire_date",

  // Wage
  wage: "wage",
  pay: "wage",
  payrate: "wage",
  rate: "wage",
  hourlywage: "wage",
  hourlyrate: "wage",

  // Wage type
  paytype: "wage_pay_type",
  wagetype: "wage_pay_type",
  payperiod: "wage_pay_type",

  // Email
  email: "email",
  emailaddress: "email",
  workemail: "email",

  // Phone
  phone: "phone",
  phonenumber: "phone",
  mobile: "phone",
  mobilephone: "phone",
  cell: "phone",
  cellphone: "phone",

  // Status
  userstatus: "status",
  status: "status",
  employeestatus: "status",
  active: "status",

  // Location label — captured per row so we can filter all-locations exports
  // down to rows belonging to the target location.
  location: "location_label",
  store: "location_label",
  storename: "location_label",
  site: "location_label",
  sitename: "location_label",
};

/**
 * Headers we know about but explicitly don't import. They appear in source
 * exports but the app stores this data elsewhere (or not at all). Silenced
 * so they don't clutter the import warnings.
 */
const SILENTLY_IGNORED_HEADERS = new Set([
  // Source-system IDs we deliberately replace with our own employee_code.
  "punchid",
  "punchno",
  "punchnumber",
  "employeeid",
  "empid",
  "employeeno",
  "employeenumber",

  // Not currently modeled.
  "department",
  "role",
  "birthdate",
  "dob",
  "dateofbirth",
  "terminationdate",
  "termdate",
  "usertype",
]);

function getField(
  row: Record<string, string>,
  canonical: string,
  headerMap: Record<string, string>
): string | undefined {
  for (const [rawHeader, canonField] of Object.entries(headerMap)) {
    if (canonField === canonical) {
      const value = row[rawHeader];
      if (value !== undefined && value !== null && value !== "") return String(value).trim();
    }
  }
  return undefined;
}

/**
 * Parse a CSV's raw text into deduplicated employee records ready to upsert.
 *
 * Behavior:
 *  - Only rows with status = "Active" are imported. Inactive rows are skipped.
 *  - Same employee across multiple role-assignment rows is collapsed to one record
 *    (dedupe key = lowercase full name).
 *  - Wage: the max non-null wage across the employee's rows wins; pay type travels with it.
 *  - Hire date: earliest non-null wins.
 *  - Punch ID and Employee ID from source systems are ignored — the app generates
 *    its own employee_code at insert time via the database default.
 */
export function parseEmployeeCsv(csvText: string): ImportResult {
  const result: ImportResult = {
    rows_in_file: 0,
    active_rows: 0,
    inactive_skipped: 0,
    unique_employees: 0,
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

  // Build header map: raw header -> canonical field name
  const rawHeaders = parsed.meta.fields ?? [];
  const headerMap: Record<string, string> = {};
  const unmatchedHeaders: string[] = [];
  for (const raw of rawHeaders) {
    const normalized = normalizeHeader(raw);
    const canonical = HEADER_ALIASES[normalized];
    if (canonical) {
      headerMap[raw] = canonical;
    } else if (!SILENTLY_IGNORED_HEADERS.has(normalized)) {
      unmatchedHeaders.push(raw);
    }
  }

  if (unmatchedHeaders.length > 0) {
    result.warnings.push(
      `Ignored ${unmatchedHeaders.length} unrecognized column${
        unmatchedHeaders.length === 1 ? "" : "s"
      }: ${unmatchedHeaders.join(", ")}`
    );
  }

  const hasName =
    Object.values(headerMap).some(
      (c) => c === "first_name" || c === "last_name" || c === "full_name"
    );
  if (!hasName) {
    result.errors.push(
      "Missing employee name column. Expected one of: First name, Last name, or Name."
    );
    return result;
  }

  // Internal accumulator type for merging across rows
  type Accum = ParsedEmployee;
  const groups = new Map<string, Accum>();

  for (const row of rows) {
    const statusRaw = getField(row, "status", headerMap);
    const isActive = statusRaw ? statusRaw.toLowerCase() === "active" : true;

    if (!isActive) {
      result.inactive_skipped += 1;
      continue;
    }
    result.active_rows += 1;

    const first = getField(row, "first_name", headerMap) ?? "";
    const last = getField(row, "last_name", headerMap) ?? "";
    const full = getField(row, "full_name", headerMap) ?? "";
    const employeeName = full || `${first} ${last}`.trim();
    if (!employeeName) continue;

    const dedupeKey = employeeName.toLowerCase();

    const hireRaw = getField(row, "hire_date", headerMap);
    const hireDate = hireRaw && /^\d{4}-\d{2}-\d{2}$/.test(hireRaw) ? hireRaw : null;
    if (hireRaw && !hireDate) {
      result.warnings.push(
        `Skipped malformed hire date "${hireRaw}" for ${employeeName}; expected YYYY-MM-DD.`
      );
    }

    const wageRaw = getField(row, "wage", headerMap);
    const wageNum = wageRaw ? Number(wageRaw.replace(/[$,]/g, "")) : null;
    const wage = wageNum !== null && !Number.isNaN(wageNum) ? wageNum : null;
    const payType = getField(row, "wage_pay_type", headerMap) ?? null;

    const emailRaw = getField(row, "email", headerMap);
    const email = emailRaw ? emailRaw.toLowerCase() : null;

    const phoneRaw = getField(row, "phone", headerMap);
    // Treat literal "0" or empty-after-trim as missing.
    const phone = phoneRaw && phoneRaw !== "0" ? phoneRaw : null;

    const locationLabel = getField(row, "location_label", headerMap) ?? null;

    const existing = groups.get(dedupeKey);
    if (!existing) {
      groups.set(dedupeKey, {
        employee_name: employeeName,
        email,
        phone,
        hire_date: hireDate,
        wage,
        wage_pay_type: wage !== null ? payType : null,
        location_label: locationLabel,
      });
    } else {
      // Earliest hire date wins
      if (hireDate && (!existing.hire_date || hireDate < existing.hire_date)) {
        existing.hire_date = hireDate;
      }
      // Max non-null wage wins; pay type travels with the wage we choose.
      if (wage !== null && (existing.wage === null || wage > existing.wage)) {
        existing.wage = wage;
        existing.wage_pay_type = payType;
      }
      // First non-empty wins for email and phone (they're typically duplicated across role rows).
      if (!existing.email && email) existing.email = email;
      if (!existing.phone && phone) existing.phone = phone;
      // Keep first non-null location label seen (rows for the same employee
      // should agree on location, but defensive).
      if (!existing.location_label && locationLabel) existing.location_label = locationLabel;
    }
  }

  result.records = Array.from(groups.values());
  result.unique_employees = result.records.length;

  return result;
}
