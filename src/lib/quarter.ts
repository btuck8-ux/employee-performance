export type Quarter = 1 | 2 | 3 | 4;

export interface QuarterInfo {
  year: number;
  quarter: Quarter;
  label: string;
  periodStart: Date;
  periodEnd: Date;
}

/** Compute the quarter that contains the given date. */
export function quarterOfDate(date: Date): QuarterInfo {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed
  const quarter = (Math.floor(month / 3) + 1) as Quarter;
  const startMonth = (quarter - 1) * 3;
  const periodStart = new Date(year, startMonth, 1);
  const periodEnd = new Date(year, startMonth + 3, 0); // last day of the 3rd month
  return {
    year,
    quarter,
    label: `Q${quarter} ${year}`,
    periodStart,
    periodEnd,
  };
}

/** Current calendar quarter (used as upload default). */
export function currentQuarter(): QuarterInfo {
  return quarterOfDate(new Date());
}

/** Build a QuarterInfo from a year + quarter pair. */
export function quarterInfo(year: number, quarter: Quarter): QuarterInfo {
  const startMonth = (quarter - 1) * 3;
  return {
    year,
    quarter,
    label: `Q${quarter} ${year}`,
    periodStart: new Date(year, startMonth, 1),
    periodEnd: new Date(year, startMonth + 3, 0),
  };
}

/**
 * Returns true if [aStart, aEnd] overlaps with [bStart, bEnd] inclusively.
 * Used by custom-range report generation to find contributing periods.
 */
export function rangesOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date
): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}
