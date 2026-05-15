import Papa from "papaparse";

// ============================================================================
// POS sales CSV parser.
//
// Handles two known header dialects without separate code paths:
//
//   Standard (5 of 6 Colorado stores):
//     Date,Receipt,Transaction Type,Order Type,Channel,Payment Type,Register,
//     Employee,Approved By,Tip ($),Total ($)
//     - Date format: "05/12/2026 07:39 PM"  (single spaces, space before AM/PM)
//     - Employee:    "Camille Woodfield"     (unquoted, First Last)
//
//   Colorado Springs dialect (CS file only):
//     Date ,Receipt ,TXN ,Order Type ,Channel ,Payment Type ,Register ,
//     Employee ,Approved By ,Tip ($),Total ($)
//     - Trailing spaces on every header  (handled by Papa transformHeader.trim())
//     - "TXN" instead of "Transaction Type"  (aliased below)
//     - Date format: "05/12/2026   07:59PM"  (multiple internal spaces, NO space before AM/PM)
//     - Employee:    '"Licano-Flying Coyote, Julia"'  (quoted, Last, First)
//
// Both formats are accepted by the same code via tolerant regexes and a small
// header-alias map.
//
// Split-tender handling: when a single check is paid across multiple payment
// methods, the POS exports one row per payment leg, all sharing the same
// Receipt + Date + Transaction Type but differing in Payment Type and amount.
// We COLLAPSE legs into a single record per receipt at parse time:
//   - tip_amount   = sum across legs
//   - total_amount = sum across legs
//   - payment_type = single leg's value, or "Split" if multiple legs
//   - raw_row.payment_legs[] preserves the per-leg detail for audit / future
//     re-derivation
// This collapse is what makes the unique (location_id, receipt_number) DB key
// safe, and it's also what makes the $175 cap behave correctly — a $300
// catering check split into 2×$150 legs is excluded because the COLLAPSED
// total is $300, not because either leg is.
// ============================================================================

interface RawRow {
  // Both dialects after header.trim() — note "TXN" is aliased to
  // "Transaction Type" via getCell().
  Date?: string;
  Receipt?: string;
  "Transaction Type"?: string;
  TXN?: string;
  "Order Type"?: string;
  Channel?: string;
  "Payment Type"?: string;
  Register?: string;
  Employee?: string;
  "Approved By"?: string;
  "Tip ($)"?: string;
  "Total ($)"?: string;
  // Reserved for future multi-location master exports — none of the current
  // 6 files have this, but rowMatchesLocation handles null gracefully.
  Location?: string;
  Store?: string;
  Site?: string;
}

export interface ParsedSalesRecord {
  receipt_number: string;
  transaction_at: string;        // "YYYY-MM-DDTHH:MM:SS" — plain timestamp (no TZ), store-local
  transaction_type: string;      // "Sales" | "Refund" (verbatim from source)
  order_type: string | null;
  channel: string | null;
  payment_type: string | null;   // single leg's value, or "Split" if collapsed from multiple legs
  register: string | null;
  pos_employee_name: string | null;  // metadata only — NOT used for tip attribution
  total_amount: number;          // signed: refunds are negative
  tip_amount: number;            // signed: refund of tip is negative
  /** Captured Location/Store/Site value from the row, for cross-location filtering. */
  location_label: string | null;
  /** Full per-leg detail preserved for audit + possible re-derivation. */
  raw_row: {
    payment_legs: Array<{
      payment_type: string | null;
      total_amount: number;
      tip_amount: number;
    }>;
  };
}

export interface PosImportResult {
  rows_in_file: number;
  unique_receipts: number;
  split_tender_receipts: number;   // receipts that had >1 payment leg
  warnings: string[];
  errors: string[];
  records: ParsedSalesRecord[];
}

// ---------- helpers ----------

function clean(s: string | undefined | null): string | null {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  return t.length === 0 ? null : t;
}

/**
 * Read a logical cell that has aliases (e.g. "Transaction Type" vs "TXN").
 * Returns the first non-empty value found among `keys`.
 */
function getCell(row: RawRow, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = (row as unknown as Record<string, string | undefined>)[k];
    const c = clean(v);
    if (c) return c;
  }
  return null;
}

/**
 * Parse an Ike's POS Date column into a plain "YYYY-MM-DDTHH:MM:SS" string
 * suitable for a Postgres `timestamp without time zone`. Handles BOTH:
 *   "05/12/2026 07:39 PM"
 *   "05/12/2026   07:59PM"
 * by collapsing all whitespace and making the AM/PM separator optional.
 */
function isoTimestamp(s: string | undefined | null): string | null {
  const c = clean(s);
  if (!c) return null;
  // Normalize internal whitespace runs to single spaces to make the regex
  // tolerant of the Colorado Springs double-space dialect.
  const normalized = c.replace(/\s+/g, " ");
  // Date + time + optional whitespace + AM/PM
  const m = normalized.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i
  );
  if (!m) return null;
  const [, mo, da, yr, hRaw, mi, seRaw, ampm] = m;
  let h = parseInt(hRaw, 10);
  const minutes = parseInt(mi, 10);
  const seconds = seRaw ? parseInt(seRaw, 10) : 0;
  if (h < 1 || h > 12 || minutes > 59 || seconds > 59) return null;
  const upper = ampm.toUpperCase();
  if (upper === "PM" && h !== 12) h += 12;
  if (upper === "AM" && h === 12) h = 0;
  const yyyy = yr;
  const mm = mo.padStart(2, "0");
  const dd = da.padStart(2, "0");
  const HH = String(h).padStart(2, "0");
  const MM = String(minutes).padStart(2, "0");
  const SS = String(seconds).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}`;
}

/**
 * Parse a money string into a signed number. Strips $, commas, surrounding
 * whitespace. Returns null only if the input is empty or unparseable —
 * "0", "0.00", and "-4.25" all return numbers.
 */
function parseMoney(s: string | undefined | null): number | null {
  const c = clean(s);
  if (!c) return null;
  const stripped = c.replace(/[$,\s]/g, "");
  // Empty after stripping (e.g., input was just "$ ")
  if (stripped === "") return null;
  // Handle parenthesized negatives just in case "(4.25)" shows up.
  const negFromParens = /^\(.*\)$/.test(stripped);
  const numeric = stripped.replace(/[()]/g, "");
  const n = Number(numeric);
  if (!Number.isFinite(n)) return null;
  return negFromParens ? -n : n;
}

// ---------- main entry point ----------

export function parseSalesCsv(csvText: string): PosImportResult {
  const result: PosImportResult = {
    rows_in_file: 0,
    unique_receipts: 0,
    split_tender_receipts: 0,
    warnings: [],
    errors: [],
    records: [],
  };

  // Some POS exports prepend a junk row or metadata rows before the real
  // header (e.g., "DTSales&Refunds 07-01-2025_11-30_2025.csv" arrived with a
  // row of bare commas on line 1). Scan the first 10 lines for a row that
  // looks like the real header — must contain "Date" and "Receipt" and
  // either "Transaction Type" or "TXN". If we find it past line 1, drop
  // everything above it before handing to Papa.
  const lines = csvText.split(/\r?\n/);
  let headerLineIdx = 0;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const cells = lines[i].split(",").map((c) => c.trim());
    const hasDate = cells.some((c) => c.toLowerCase() === "date");
    const hasReceipt = cells.some((c) => c.toLowerCase() === "receipt");
    const hasTxType = cells.some(
      (c) =>
        c.toLowerCase() === "transaction type" || c.toLowerCase() === "txn"
    );
    if (hasDate && hasReceipt && hasTxType) {
      headerLineIdx = i;
      break;
    }
  }
  if (headerLineIdx > 0) {
    result.warnings.push(
      `Skipped ${headerLineIdx} junk row(s) before the real header.`
    );
  }
  const cleanedCsv = lines.slice(headerLineIdx).join("\n");

  const parsed = Papa.parse<RawRow>(cleanedCsv, {
    header: true,
    skipEmptyLines: true,
    // Trim trailing spaces on Colorado Springs headers ("Date " → "Date", etc.)
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) {
      // Papa reports cosmetic warnings (e.g., field count drift) as errors at
      // row level — surface them but don't abort.
      result.warnings.push(`Row ${err.row ?? "?"}: ${err.message}`);
    }
  }

  const rows = parsed.data;
  result.rows_in_file = rows.length;
  if (rows.length === 0) {
    result.errors.push("CSV is empty.");
    return result;
  }

  // Group payment legs by (receipt, timestamp, type). Same receipt with
  // different timestamp/type stays separate — defensive against the rare
  // case where receipt # is reused across days or transaction types.
  interface LegGroup {
    receipt_number: string;
    transaction_at: string;
    transaction_type: string;
    order_type: string | null;
    channel: string | null;
    register: string | null;
    pos_employee_name: string | null;
    location_label: string | null;
    legs: Array<{
      payment_type: string | null;
      total_amount: number;
      tip_amount: number;
    }>;
    /** Track conflicting receipt-level field values across legs (rare). */
    fieldConflicts: Set<string>;
  }
  const groups = new Map<string, LegGroup>();
  let skippedNoRequired = 0;
  let skippedBadTotal = 0;

  for (const row of rows) {
    const receipt = getCell(row, ["Receipt"]);
    const dateCell = getCell(row, ["Date"]);
    const txType = getCell(row, ["Transaction Type", "TXN"]);
    const totalRaw = getCell(row, ["Total ($)", "Total"]);
    const tipRaw = getCell(row, ["Tip ($)", "Tip"]);

    if (!receipt || !dateCell || !txType) {
      skippedNoRequired += 1;
      continue;
    }
    const transactionAt = isoTimestamp(dateCell);
    if (!transactionAt) {
      skippedNoRequired += 1;
      continue;
    }
    const total = parseMoney(totalRaw);
    if (total === null) {
      skippedBadTotal += 1;
      continue;
    }
    // Tip can legitimately be missing/blank → treat as $0.
    const tip = parseMoney(tipRaw) ?? 0;

    const orderType = getCell(row, ["Order Type"]);
    const channel = getCell(row, ["Channel"]);
    const paymentType = getCell(row, ["Payment Type"]);
    const register = getCell(row, ["Register"]);
    const employee = getCell(row, ["Employee"]);
    const locationLabel = getCell(row, ["Location", "Store", "Site"]);

    const key = `${receipt}|${transactionAt}|${txType.toLowerCase()}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        receipt_number: receipt,
        transaction_at: transactionAt,
        transaction_type: txType,
        order_type: orderType,
        channel,
        register,
        pos_employee_name: employee,
        location_label: locationLabel,
        legs: [],
        fieldConflicts: new Set(),
      };
      groups.set(key, group);
    } else {
      // Track if subsequent legs disagree on receipt-level fields. Should
      // be rare; if it happens we keep the first leg's value and warn once
      // per receipt + field at the end.
      if (orderType && group.order_type && orderType !== group.order_type) {
        group.fieldConflicts.add("order_type");
      }
      if (channel && group.channel && channel !== group.channel) {
        group.fieldConflicts.add("channel");
      }
      if (register && group.register && register !== group.register) {
        group.fieldConflicts.add("register");
      }
      if (
        employee &&
        group.pos_employee_name &&
        employee !== group.pos_employee_name
      ) {
        group.fieldConflicts.add("pos_employee_name");
      }
      // Backfill any field the first leg missed.
      if (!group.order_type) group.order_type = orderType;
      if (!group.channel) group.channel = channel;
      if (!group.register) group.register = register;
      if (!group.pos_employee_name) group.pos_employee_name = employee;
      if (!group.location_label) group.location_label = locationLabel;
    }

    group.legs.push({
      payment_type: paymentType,
      total_amount: total,
      tip_amount: tip,
    });
  }

  if (skippedNoRequired > 0) {
    result.warnings.push(
      `Skipped ${skippedNoRequired} rows missing required fields (Receipt / Date / Transaction Type) or with an unparseable date.`
    );
  }
  if (skippedBadTotal > 0) {
    result.warnings.push(
      `Skipped ${skippedBadTotal} rows with an unparseable Total ($) value.`
    );
  }

  // Collapse legs into ParsedSalesRecord. Sum tip + total; pick payment_type
  // = single-leg value or "Split"; preserve all leg detail in raw_row.
  let splitTenderCount = 0;
  const conflictWarnings = new Map<string, number>(); // field -> count

  for (const g of groups.values()) {
    const total = g.legs.reduce((a, l) => a + l.total_amount, 0);
    const tip = g.legs.reduce((a, l) => a + l.tip_amount, 0);
    const paymentType =
      g.legs.length === 1
        ? g.legs[0].payment_type
        : g.legs.every((l) => l.payment_type === g.legs[0].payment_type)
          ? g.legs[0].payment_type
          : "Split";

    if (g.legs.length > 1) splitTenderCount += 1;
    for (const field of g.fieldConflicts) {
      conflictWarnings.set(field, (conflictWarnings.get(field) ?? 0) + 1);
    }

    result.records.push({
      receipt_number: g.receipt_number,
      transaction_at: g.transaction_at,
      transaction_type: g.transaction_type,
      order_type: g.order_type,
      channel: g.channel,
      payment_type: paymentType,
      register: g.register,
      pos_employee_name: g.pos_employee_name,
      total_amount: Math.round(total * 100) / 100,  // float arithmetic guard
      tip_amount: Math.round(tip * 100) / 100,
      location_label: g.location_label,
      raw_row: {
        payment_legs: g.legs,
      },
    });
  }

  for (const [field, count] of conflictWarnings) {
    result.warnings.push(
      `${count} receipt(s) had differing ${field} across payment legs; first-leg value kept.`
    );
  }

  result.unique_receipts = result.records.length;
  result.split_tender_receipts = splitTenderCount;
  return result;
}
