/**
 * Should a CSV row whose Location/Store/Site value is `rowLabel` be ingested
 * into the location named `targetName` (or matching one of its aliases)?
 *
 * Rules:
 *  - If `rowLabel` is null/empty/whitespace, return true. The CSV either had
 *    no Location column at all, or this specific row didn't fill it in. We
 *    fall through to the existing "use the location chosen in the UI"
 *    behavior — so single-location exports continue to work unchanged.
 *  - Compare case-insensitive after trimming, against the canonical name AND
 *    every alias in `aliases`. Each location can declare a list of CSV
 *    aliases (`locations.csv_aliases TEXT[]`) — useful when different vendors
 *    use different naming conventions (e.g., payroll says "Ike's - Central
 *    Park" while Tattle says "Denver (Central Park)").
 *  - Aliases are optional. Callers without an aliases list (or with null)
 *    behave exactly like the original two-arg version.
 */
export function rowMatchesLocation(
  rowLabel: string | null | undefined,
  targetName: string,
  aliases?: string[] | null
): boolean {
  if (!rowLabel) return true;
  const r = String(rowLabel).trim().toLowerCase();
  if (r === "") return true;
  if (r === targetName.trim().toLowerCase()) return true;
  if (aliases && aliases.length > 0) {
    for (const a of aliases) {
      if (!a) continue;
      if (r === a.trim().toLowerCase()) return true;
    }
  }
  return false;
}
