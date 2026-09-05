/**
 * Contract pins for the employee-transfer rule (MASTER sprint W1, ruled
 * 2026-09-04) — TEXT-LEVEL pins per repo convention.
 *
 * A transfer updates the employee's current location and NOTHING else.
 * Historical performance_records rows stay attributed to the store where
 * the work happened: post-093, location_id is part of row identity
 * (employee_id, report_period_id, location_id), not a denormalised column
 * to keep in step. The deleted sync rewrote EVERY period including frozen
 * 2025 — re-attributing history THQ holds value-only fingerprints on,
 * moving effective_period_start (CP's below-line buckets), and bypassing
 * frozenQuarterRefusal, which lives in the recompute asset, not the edit
 * form. These pins keep that write from coming back, and keep BOTH stores'
 * pages revalidating on a transfer (a check on only the new store would
 * pass a broken implementation).
 *
 * 09-07 identity precondition (spec-one-master-code-migration-SCOPE §
 * PRECONDITION): this guard lands BEFORE employee_ids collapse — after the
 * collapse, the old .eq("employee_id", id) predicate would have swept every
 * store's history in one statement.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const editActionsSrc = read("src/app/dashboard/employees/[id]/edit/actions.ts");

test("W1 evidence 1: a transfer never touches performance_records — no reference at all in the edit action", () => {
  // The strongest text-level form of "every historical row is byte-identical
  // afterwards": the file contains no performance_records read or write, so
  // there is no code path by which the action can mutate any historical row,
  // frozen or open. The only remaining writers are the recompute asset (which
  // carries frozenQuarterRefusal and the metrics floor) and the per-field
  // tattle/manager-feedback writers.
  assert.doesNotMatch(
    editActionsSrc,
    /performance_records/,
    "edit action must not reference performance_records — a transfer never mutates a historical performance row"
  );
});

test("W1: the employee-row update and its error handling survive the deletion", () => {
  assert.match(editActionsSrc, /\.from\("employees"\)\s*\n?\s*\.update\(/);
  // Error handling on the employee update still redirects with the message.
  assert.match(editActionsSrc, /if \(error\) \{/);
  assert.match(editActionsSrc, /encodeURIComponent\(error\.message\)/);
});

test("W1 evidence 2a: transfer detection is still computed (old vs new location)", () => {
  assert.match(editActionsSrc, /old_location_id && old_location_id !== new_location_id/);
});

test("W1 evidence 2b: BOTH stores' pages revalidate — new location unconditionally, old location on transfer", () => {
  assert.match(
    editActionsSrc,
    /revalidatePath\(`\/dashboard\/locations\/\$\{new_location_id\}`\)/,
    "new store's location page must revalidate"
  );
  assert.match(
    editActionsSrc,
    /if \(old_location_id && isTransfer\) \{\s*\n\s*revalidatePath\(`\/dashboard\/locations\/\$\{old_location_id\}`\);/,
    "old store's location page must revalidate on transfer — checking only the new store passes a broken implementation"
  );
});

test("W1: employee pages still revalidate", () => {
  assert.match(editActionsSrc, /revalidatePath\(`\/dashboard\/employees\/\$\{id\}`\)/);
  assert.match(editActionsSrc, /revalidatePath\("\/dashboard\/employees"\)/);
});
