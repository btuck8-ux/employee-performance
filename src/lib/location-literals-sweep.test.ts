/**
 * Structural sweep: no hardcoded location-code literal in production src/
 * (LOCATION_CODES packet, Tucker 2026-08-26).
 *
 * THE RULE: DO NOT KEEP A COPY OF ANYTHING THE DATABASE OWNS.
 * `public.locations` owns the code set, the timezones, and the CP wiring.
 * The hand-maintained copies are exactly how FCCSU 400'd on both feeds,
 * silently vanished from an unfiltered range query, and carried correct
 * wall-clock times only by the coincidence of being a Denver store.
 *
 * Same shape as the mig-056 non-puncher flag's structural sweep (that
 * pattern works): any NEW file that quotes a location code must consciously join
 * the allowlist below with a justification — or, almost always, read the
 * fact from `locations` instead.
 *
 * Test files are exempt: fixtures quoting a code are arbitrary test data,
 * not copies of the roster. The codes listed here are the sweep's search
 * KEYS, not a roster the app consults — a tenth store needs no edit here
 * to be served (that is the whole point), though adding its code extends
 * the sweep's reach to future regressions mentioning it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const LITERAL_RE =
  /['"`](CPD|COS|DTD|FCOL|FCCSU|HRANCH|HOU|LONGM|NOLA)['"`]/;

const ALLOWLIST = new Set([
  // Operator probe tool: ?deep_dive_code defaults to one store for CLI
  // ergonomics — a probe subject, not a roster copy. Validated against the
  // live crosswalk at runtime.
  "src/app/api/admin/probe-7shifts-shifts/route.ts",
  // Guest-feedback harvest: the one store with no Tattle/Reviews merchant.
  // A vendor-coverage fact the DB does not own YET — flagged to Tucker in
  // the LOCATION_CODES packet report; if a locations column lands for it,
  // this entry dies with the literal.
  "src/lib/ingest/guest-feedback/harvest.ts",
]);

test("structural sweep: no hardcoded location literal outside the allowlist", () => {
  const root = process.cwd();
  const offenders: string[] = [];
  for (const entry of readdirSync(join(root, "src"), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue; // fixtures are fine
    const full = join(
      entry.parentPath ?? (entry as unknown as { path: string }).path,
      entry.name
    );
    const rel = relative(root, full);
    if (!LITERAL_RE.test(readFileSync(full, "utf8"))) continue;
    if (!ALLOWLIST.has(rel)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    "hardcoded location literal(s) found — read the fact from public.locations instead, or consciously join the allowlist with a justification"
  );
});

test("the allowlist itself stays honest — every entry still contains a literal", () => {
  // A stale allowlist entry is cover for a future regression: if a listed
  // file goes clean, remove it so the sweep tightens.
  const root = process.cwd();
  for (const rel of ALLOWLIST) {
    const src = readFileSync(join(root, rel), "utf8");
    assert.match(
      src,
      LITERAL_RE,
      `${rel} no longer contains a location literal — remove it from the allowlist`
    );
  }
});
