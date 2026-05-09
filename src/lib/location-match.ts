/**
 * Should a CSV row whose Location/Store/Site value is `rowLabel` be ingested
 * into the location named `targetName`?
 *
 * Rules:
 *  - If `rowLabel` is null/empty/whitespace, return true. The CSV either had
 *    no Location column at all, or this specific row didn't fill it in. We
 *    fall through to the existing "use the location chosen in the UI"
 *    behavior — so single-location exports continue to work unchanged.
 *  - Otherwise compare case-insensitive after trimming. Exact match required.
 *
 * Future: if Tucker's source systems use different display names than our
 * `locations.name` (e.g. "Ike's Houston" in CSV vs "Houston Heights" in DB),
 * we'll add a `csv_aliases TEXT[]` column on `locations` and check it here.
 * For now exact-match-after-trim covers the all-locations exports we've seen.
 */
export function rowMatchesLocation(
  rowLabel: string | null | undefined,
  targetName: string
): boolean {
  if (!rowLabel) return true;
  const r = String(rowLabel).trim().toLowerCase();
  if (r === "") return true;
  const t = targetName.trim().toLowerCase();
  return r === t;
}
