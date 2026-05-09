/**
 * Parse a date-only string (YYYY-MM-DD) as LOCAL midnight, not UTC.
 * Fixes the off-by-one-day bug that hits negative-offset timezones when you
 * `new Date("2025-11-10")` and read .getDate() in local time.
 */
function parseDateLocal(value: Date | string): Date {
  if (value instanceof Date) return value;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  return new Date(value);
}

/** Display Hire Date as e.g. "July 14th, 2025". */
export function formatHireDate(date: Date | string): string {
  const d = parseDateLocal(date);
  if (Number.isNaN(d.getTime())) return "—";
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const day = d.getDate();
  const suffix = ordinalSuffix(day);
  return `${months[d.getMonth()]} ${day}${suffix}, ${d.getFullYear()}`;
}

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function toNum(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isNaN(n) ? null : n;
}

/** Format a number as a percentage with two decimals, e.g. "89.86%". */
export function formatPercent(value: number | string | null | undefined): string {
  const n = toNum(value);
  return n === null ? "—" : n.toFixed(2) + "%";
}

/** Format a rating with two decimals, e.g. "4.50". */
export function formatRating(value: number | string | null | undefined): string {
  const n = toNum(value);
  return n === null ? "—" : n.toFixed(2);
}

/** Format a count as a whole number. */
export function formatQuantity(value: number | string | null | undefined): string {
  const n = toNum(value);
  return n === null ? "—" : Math.round(n).toString();
}

/**
 * "X years, Y months" with zero suppression on either component.
 * Examples: "1 year, 3 months"; "0 years, 4 months"; "2 years, 0 months".
 */
export function formatTenure(hireDate: Date | string, asOf: Date | string = new Date()): string {
  const start = parseDateLocal(hireDate);
  const end = typeof asOf === "string" ? parseDateLocal(asOf) : asOf;
  if (Number.isNaN(start.getTime())) return "—";

  let years = end.getFullYear() - start.getFullYear();
  let months = end.getMonth() - start.getMonth();
  if (end.getDate() < start.getDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years < 0) return "—";
  return `${years} ${years === 1 ? "year" : "years"}, ${months} ${months === 1 ? "month" : "months"}`;
}
