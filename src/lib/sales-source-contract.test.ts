/**
 * Contract pins for sales_records.source (mig 059, Houston-to-Toast spec
 * 2026-08-25 §3) — TEXT-LEVEL pins per repo convention.
 *
 * The column exists so the Houston cutover can be a read-time preference
 * instead of a destructive write. Its charter: classified from raw_row
 * PAYLOAD shape, never key format (the method rule that settled Houston's
 * source); every writer stamps it; a null after backfill is a finding, and
 * there is deliberately NO catch-all classifier — a guessed source is
 * worse than a loud unknown.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const migSrc = read("supabase/migrations/059_sales_records_source.sql");
const normalizeSrc = read("src/lib/ingest/toast/normalize.ts");
const receiptsSrc = read("src/lib/ingest/sevenshifts/receipts.ts");
const uploadSrc = read("src/app/dashboard/locations/[id]/upload-pos-actions.ts");

test("mig 059: the four-value check, and classification by PAYLOAD keys only", () => {
  assert.match(migSrc, /check \(source in \('sevenshifts', 'toast', 'legacy_pos', 'csv'\)\)/);
  // Pin the UPDATE predicates themselves, not the header prose (Codex
  // 2026-08-25: a comment-matching pin survives classifier drift). Each
  // classifier is anchored: set-value + null guard + its decisive key.
  assert.match(
    migSrc,
    /set source = 'toast'\s*\n\s*where source is null\s*\n\s*and raw_row is not null\s*\n\s*and raw_row \? 'order_guid'/
  );
  assert.match(
    migSrc,
    /set source = 'sevenshifts'\s*\n\s*where source is null\s*\n\s*and raw_row is not null\s*\n\s*and \(raw_row \? 'external_user_id' or raw_row \? 'gross_total_cents'\)/
  );
  assert.match(
    migSrc,
    /set source = 'legacy_pos'\s*\n\s*where source is null\s*\n\s*and raw_row is not null\s*\n\s*and raw_row \? 'payment_legs'/
  );
  assert.doesNotMatch(migSrc, /receipt_number\s+(like|~|similar)/i, "shape is not identity");
});

test("mig 059: idempotent, no catch-all, and the report-then-stop is documented", () => {
  const guards = migSrc.match(/where source is null/g) ?? [];
  assert.equal(guards.length, 3, "every classifier guards on source is null");
  // No unconditional assignment: exactly three updates, each shape-keyed.
  const updates = migSrc.match(/update public\.sales_records/g) ?? [];
  assert.equal(updates.length, 3, "three classifiers, no fourth catch-all");
  assert.match(migSrc, /STOP for review/);
  assert.match(migSrc, /UNCLASSIFIED/);
});

test("every sales_records writer stamps source — never null", () => {
  // normalize.ts covers BOTH Toast writers (nightly orders feed + gap
  // lever) because both upsert its payloads verbatim.
  assert.match(normalizeSrc, /source: "toast"/);
  assert.match(receiptsSrc, /source: "sevenshifts"/);
  // The POS CSV importer parses exactly the payment_legs Sales & Refunds
  // shape, so it stamps legacy_pos; 'csv' is reserved for a future generic
  // importer (recorded choice, PR #32).
  assert.match(uploadSrc, /source: "legacy_pos"/);
});
