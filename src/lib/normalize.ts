/**
 * Normalize percentages to a 0–100 numeric value regardless of input form.
 * Handles 0.8986, 89.86, "89.86%", "0.8986".
 */
export function normalizePercent(input: number | string | null | undefined): number | null {
  if (input === null || input === undefined || input === "") return null;
  let value: number;
  if (typeof input === "string") {
    const cleaned = input.trim().replace(/%$/, "");
    if (cleaned === "") return null;
    value = Number(cleaned);
  } else {
    value = input;
  }
  if (Number.isNaN(value)) return null;
  // Heuristic: |value| <= 1 → treat as fraction, scale to percent.
  // Negatives are unusual for these metrics but we preserve the absolute-value heuristic.
  return Math.abs(value) <= 1 ? value * 100 : value;
}

/** Coerce a rating value (e.g. "4.5", "4.50", 4.5) to a number; null if empty/invalid. */
export function normalizeRating(input: number | string | null | undefined): number | null {
  if (input === null || input === undefined || input === "") return null;
  const value = typeof input === "string" ? Number(input.trim()) : input;
  return Number.isNaN(value) ? null : value;
}

/** Coerce an integer count value; null if empty/invalid. */
export function normalizeCount(input: number | string | null | undefined): number | null {
  if (input === null || input === undefined || input === "") return null;
  const value = typeof input === "string" ? Number(input.trim()) : input;
  if (Number.isNaN(value)) return null;
  return Math.round(value);
}

/** Coerce a date string into a JS Date; null if empty/invalid. */
export function normalizeDate(input: string | Date | null | undefined): Date | null {
  if (!input) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}
