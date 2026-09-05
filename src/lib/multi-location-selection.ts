/**
 * Pure selection model for the multi-location card (W6, MASTER sprint).
 *
 * The card's whole fetch-to-render path keys on the COMPOSITE
 * (employeeId, locationId) — the five CP3 defects all reduced to
 * employeeId doubling as slice identity, which collapses precisely the
 * requested case: one employee row transferred between stores. This module
 * is the client card's state machine, extracted pure so the packet's
 * interaction cases — (a) one transferred row, (b) sibling rows at
 * different stores, (c) multiple location rows within a single quarter —
 * are unit-testable without a DOM harness.
 *
 * ⚠️ NAVIGATION IS THE EXCEPTION: nothing here builds a URL, and nothing
 * ever should from a slice key. Employee URLs take a bare employeeId; two
 * slices may legitimately link to the same profile.
 */

import type { LocationQuarterMetrics } from "./multi-location-metrics";

export interface StoreSlice {
  employeeId: string;
  locationId: string;
  employeeCode: string;
  locationName: string;
}

/** A quarter wholly below a store's floor is not-computable there — the
 * clamp itself is computeMetricsFromEntries's metricsStartFloor; this
 * predicate only marks the slice so the card can say WHY the labor cells
 * are empty. Null floor = NO floor (NOLA) — never epoch, never today. */
export function quarterBelowFloor(
  periodEnd: string,
  metricsStart: string | null
): boolean {
  return metricsStart !== null && periodEnd < metricsStart;
}

/** The composite slice key. UUIDs never contain "::" so this cannot
 * collide; the key is for state maps and React keys ONLY — never URLs. */
export function sliceKey(s: { employeeId: string; locationId: string }): string {
  return `${s.employeeId}::${s.locationId}`;
}

/** Every slice starts selected. */
export function initialChecked(
  slices: Array<{ employeeId: string; locationId: string }>
): Record<string, boolean> {
  return Object.fromEntries(slices.map((s) => [sliceKey(s), true]));
}

export function toggleChecked(
  checked: Record<string, boolean>,
  key: string,
  value: boolean
): Record<string, boolean> {
  return { ...checked, [key]: value };
}

/** The selected slices, in slice order. */
export function selectedSlices<T extends { employeeId: string; locationId: string }>(
  slices: T[],
  checked: Record<string, boolean>
): T[] {
  return slices.filter((s) => checked[sliceKey(s)]);
}

/**
 * The per-quarter combinable subset for the current selection — the exact
 * rows handed to combineQuarterMetrics. Keyed on the composite, so two
 * store records within one quarter select independently.
 */
export function quarterSubset(
  perLocationQuarter: LocationQuarterMetrics[],
  quarterId: string,
  checked: Record<string, boolean>
): LocationQuarterMetrics[] {
  return perLocationQuarter.filter(
    (p) => p.quarterId === quarterId && checked[sliceKey(p)]
  );
}

/** Selected slices that sit below their store's floor for this quarter —
 * surfaced so a hole in the combined figure is attributed, never silent. */
export function belowFloorSlices(
  perLocationQuarter: LocationQuarterMetrics[],
  quarterId: string,
  checked: Record<string, boolean>
): LocationQuarterMetrics[] {
  return quarterSubset(perLocationQuarter, quarterId, checked).filter(
    (p) => p.belowFloor
  );
}

/**
 * The slice set from roster rows + historical performance-record locations
 * (pure; the fetch uses this verbatim so the dedup is fixture-testable).
 * Roster-current store and a record at the same store dedup to ONE slice.
 */
export function buildSliceList(
  empRows: Array<{ id: string; location_id: string }>,
  records: Array<{ employee_id: string; location_id: string | null }>
): Array<{ employeeId: string; locationId: string }> {
  const seen = new Set<string>();
  const out: Array<{ employeeId: string; locationId: string }> = [];
  const add = (employeeId: string, locationId: string | null) => {
    if (!locationId) return;
    const k = `${employeeId}::${locationId}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ employeeId, locationId });
  };
  for (const r of empRows) add(String(r.id), String(r.location_id));
  for (const r of records) add(String(r.employee_id), r.location_id);
  return out;
}

/** The one attribution-bucketing predicate (pure; the fetch imports it):
 * an attributed survey/review belongs to a slice iff it belongs to that
 * slice's employee row AND was left at that slice's store. */
export function attributionBelongsToSlice(
  itemEmployeeId: string,
  itemLocationId: string,
  slice: { employeeId: string; locationId: string }
): boolean {
  return (
    itemEmployeeId === slice.employeeId && itemLocationId === slice.locationId
  );
}
