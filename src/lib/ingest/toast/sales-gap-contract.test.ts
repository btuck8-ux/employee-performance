/**
 * Contract pins for the Toast → sales_records gap-filler (addendum
 * 2026-08-25 §2) — TEXT-LEVEL pins per repo convention.
 *
 * The lever exists for Houston's 26-day sales hole (2026-05-05 → 05-30) in
 * its 7shifts pos_receipts mirror (addendum 2's §2 "correction" was
 * RETRACTED 2026-08-25 — raw_row payloads settled it: Houston's rows are
 * 7shifts receipts, cents-denominated with external_user_id, never Toast
 * orders; shape is not identity). The id spaces genuinely differ (7shifts
 * receipt_id vs Toast check.guid), so the collision report is load-bearing;
 * this particular window is safe only because it is fully disjoint from
 * every existing row (05-04 ← gap → 05-31, zero rows between — expected
 * dry-run: zero overlap, zero collisions, zero existing rows per day).
 * Its charter: explicit bounded window, dry-run by default with the
 * double-count report, write only with the affected quarters named, never
 * a subscription, never a nightly high-water mark move, and the mig 041
 * rule stands — toast_sales_enabled is untouched until Tucker rules on
 * Houston's ongoing source from the dry-run output.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const routeSrc = read("src/app/api/admin/backfill-toast-sales-gap/route.ts");

test("dry-run is the default; write requires explicit &write=1 after SA review", () => {
  assert.match(routeSrc, /searchParams\.get\("write"\) === "1"/);
  // The dry-run return sits BEFORE any upsert in source order.
  const dryReturn = routeSrc.indexOf("if (!write)");
  const upsert = routeSrc.indexOf('from("sales_records").upsert');
  assert.ok(dryReturn > 0 && upsert > 0 && dryReturn < upsert, "dry-run gate must precede the write");
});

test("write mode names its quarters: confirm_quarters must echo the affected set exactly", () => {
  // A recompute reaching a THQ frozen quarter must be a conscious, named
  // act, never a side effect of a wide window (Codex 2026-08-25).
  assert.match(routeSrc, /quarters_affected/);
  assert.match(routeSrc, /confirm_quarters/);
  const guard = routeSrc.indexOf("confirm_quarters");
  const upsert = routeSrc.indexOf('from("sales_records").upsert');
  assert.ok(guard > 0 && guard < upsert, "the quarter guard must precede the write");
});

test("the lever never moves a nightly high-water mark and never touches the subscription flag", () => {
  // ingest_runs drives lastSuccessfulWindowEnd for the toast_sales nightly;
  // an operator lever writing it would shift the CO stores' windows.
  assert.doesNotMatch(routeSrc, /from\("ingest_runs"\)|startRun\(|finishRun\(/);
  // mig 041: never set toast_sales_enabled for HOU. The lever neither reads
  // nor writes the flag — GUID + explicit window is its whole authority.
  // (Quoted/keyed forms only; the header names the trap in prose.)
  assert.doesNotMatch(routeSrc, /"toast_sales_enabled"|toast_sales_enabled\s*[:=]/);
});

test("§1 discipline: the store's own go-live is the floor, null fails loudly, window rides the response", () => {
  assert.match(routeSrc, /from < goLive \? goLive : from/);
  assert.match(routeSrc, /no toast_sales_start_date/);
  assert.match(routeSrc, /window: \{ since: dates\[0\], until: dates\[dates\.length - 1\], requests: dates\.length \}/);
});

test("dedup: same upsert key as every sales_records writer, and the double-count signature is reported", () => {
  assert.match(routeSrc, /onConflict: "location_id,receipt_number,transaction_at"/);
  // Rows on both sides with zero shared receipt_numbers = different id
  // spaces (Toast check.guid vs 7shifts receipt_id) = an insert that
  // double-counts. The report must carry the flag per day.
  assert.match(routeSrc, /double_count_risk/);
  assert.match(routeSrc, /receipt_number_overlap/);
  assert.match(routeSrc, /exact_key_collisions/);
});

test("the lever writes sales_records only — never time_entries, never actuals_source", () => {
  assert.doesNotMatch(routeSrc, /from\("time_entries"\)/);
  assert.doesNotMatch(routeSrc, /"actuals_source"|actuals_source:/);
});
