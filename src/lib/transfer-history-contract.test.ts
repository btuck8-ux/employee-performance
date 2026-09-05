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
import { readFileSync, readdirSync } from "node:fs";
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

test("W1 REPO-WIDE (G2 2a): no file outside the recompute path updates performance_records carrying location_id", () => {
  // The single-file pins above stop the write coming back in the edit
  // action; this pin stops it appearing ANYWHERE else. Post-093,
  // location_id is row identity — only the recompute asset (which carries
  // frozenQuarterRefusal and the metrics floor) may stamp it, and it does
  // so via upsert-as-row-identity, never re-attribution of existing rows.
  const RECOMPUTE_PATH = ["src/lib/performance-recompute.ts"];

  const files: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), "src"), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    files.push(join(entry.parentPath, entry.name));
  }
  assert.ok(files.length > 100, "repo walk must actually find the tree");

  const offenders: string[] = [];
  for (const abs of files) {
    if (abs.endsWith(".test.ts")) continue; // tests may quote the pattern
    const src = readFileSync(abs, "utf8");
    if (!src.includes('from("performance_records")')) continue;
    const isRecompute = RECOMPUTE_PATH.some((p) => abs.endsWith(p));
    // Every .update( chained after a performance_records from(): the
    // literal payload must not carry location_id, and a non-literal
    // payload (which this pin cannot inspect) is itself an offence
    // outside the recompute path — widen the allowlist deliberately if
    // one ever becomes legitimate.
    const chains = src.matchAll(
      /\.from\(\s*"performance_records"\s*\)[\s\S]{0,400}?\.update\(\s*(\{[\s\S]*?\}|\S{0,60})\s*\)/g
    );
    for (const m of chains) {
      if (isRecompute) continue;
      const payload = m[1];
      if (!payload.startsWith("{")) {
        offenders.push(`${abs}: non-literal update payload after from("performance_records") — uninspectable, not allowed`);
      } else if (/location_id/.test(payload)) {
        offenders.push(`${abs}: update payload carries location_id — a transfer must never re-attribute history`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});
