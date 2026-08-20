/**
 * Tip vs-store badge copy + tones (kickoff 2026-08-19 §2b/§2c, §5-E locked:
 * dollar framing, both badges).
 *
 * Tip rate = tips ÷ sales, so a rate delta of −0.35pp is EXACTLY 35¢ less in
 * tips per $100 of sales — the dollar phrasing is a unit conversion
 * (pp × 100 = cents per $100 sold), not an approximation.
 *
 * Shared by the dashboard badges (PerformanceHistoryTabs) and the PDF rows
 * (EmployeeReport) so the UI and the report can never drift. Pure module,
 * deliberately server-safe (no "use client") per the 8/17 boundary rule.
 *
 * NOT used by the Customer Service breakdown's "Tip-rate delta" row — that is
 * a data table showing the native pp value, not a status badge (kickoff §1).
 */

/** Neutral band around the location tip-rate average (percentage points). */
export const TIP_DELTA_NEUTRAL_PP = 0.25;

/**
 * Neutral band for the Tip/Hour vs-store badge, in dollars per hour.
 * ±$0.25/hr — delegated micro-call (kickoff §5): chosen to mirror the rate
 * band's practical magnitude (±0.25pp ≈ 25¢ per $100 sold; at typical
 * sandwich-shop per-hour sales that lands in the same tens-of-cents-per-hour
 * range), flagged in the PR body for Tucker's eyeball.
 */
export const TIP_PER_HOUR_NEUTRAL_USD = 0.25;

export type TipTone = "exceeds" | "meets" | "below";

export function tipRateTone(deltaPp: number): TipTone {
  if (deltaPp > TIP_DELTA_NEUTRAL_PP) return "exceeds";
  if (deltaPp < -TIP_DELTA_NEUTRAL_PP) return "below";
  return "meets";
}

export function tipPerHourTone(deltaUsd: number): TipTone {
  if (deltaUsd > TIP_PER_HOUR_NEUTRAL_USD) return "exceeds";
  if (deltaUsd < -TIP_PER_HOUR_NEUTRAL_USD) return "below";
  return "meets";
}

/**
 * "35¢ per $100 sold below store average" — the §5-E visible label.
 * ≥ 100¢ switches to dollar form ("$1.20 per $100 sold …"); a delta that
 * rounds to 0¢ reads "at store average". All glyphs are WinAnsi-safe for the
 * PDF's Helvetica (¢ yes, arrows no — arrows stay UI-only).
 */
export function tipRateDeltaLabel(deltaPp: number): string {
  const cents = Math.abs(deltaPp) * 100;
  const rounded = Math.round(cents);
  if (rounded === 0) return "at store average";
  const amount = rounded >= 100 ? `$${(rounded / 100).toFixed(2)}` : `${rounded}¢`;
  return `${amount} per $100 sold ${deltaPp > 0 ? "above" : "below"} store average`;
}

/** "$1.51/hr below store average" — the §2c Tip/Hour vs-store label. */
export function tipPerHourDeltaLabel(deltaUsd: number): string {
  const abs = Math.abs(deltaUsd);
  if (abs < 0.005) return "at store average";
  return `$${abs.toFixed(2)}/hr ${deltaUsd > 0 ? "above" : "below"} store average`;
}
