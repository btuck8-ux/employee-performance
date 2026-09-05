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

import { findTransferRewriteOffences } from "./transfer-history-scan.ts";

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

test("W1 REPO-WIDE (G2 2a): no file outside the recompute path updates performance_records via an unsafe payload", () => {
  // The single-file pins above stop the write coming back in the edit
  // action; this sweep stops it appearing ANYWHERE else — src AND scripts,
  // ts/tsx/js/mjs. Post-093, location_id is row identity — only the
  // recompute asset (which carries frozenQuarterRefusal and the metrics
  // floor) may stamp it, via upsert-as-row-identity. The scanner walks the
  // actual fluent chain (transfer-history-scan.ts), so another table's
  // .update() nearby can NOT false-positive, and gaps/whitespace/generics
  // can NOT dodge it; its bypass fixtures are tested below.
  const ALLOWLIST = new Set(["src/lib/performance-recompute.ts"]);
  // The pin's own machinery quotes the pattern and is excluded, as are
  // colocated tests (they may quote it too).
  const SELF = new Set(["src/lib/transfer-history-scan.ts"]);

  const files: string[] = [];
  for (const root of ["src", "scripts"]) {
    for (const entry of readdirSync(join(process.cwd(), root), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;
      files.push(join(entry.parentPath, entry.name));
    }
  }
  assert.ok(files.length > 100, "repo walk must actually find the tree");

  const offenders: string[] = [];
  let scanned = 0;
  for (const abs of files) {
    const rel = abs.slice(abs.indexOf(`${process.cwd()}/`) === 0 ? process.cwd().length + 1 : 0);
    if (rel.endsWith(".test.ts") || SELF.has(rel) || ALLOWLIST.has(rel)) continue;
    const src = readFileSync(abs, "utf8");
    if (!src.includes("performance_records")) continue;
    scanned++;
    for (const offence of findTransferRewriteOffences(src)) {
      offenders.push(`${rel}: ${offence}`);
    }
  }
  assert.ok(scanned >= 10, `sweep must reach the known performance_records readers (scanned ${scanned})`);
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

// ---- bypass fixtures for the scanner (Codex should-fix 2026-09-05) ----

test("scanner catches the original deleted write", () => {
  assert.equal(
    findTransferRewriteOffences(
      `await supabase.from("performance_records").update({ location_id: new_location_id }).eq("employee_id", id);`
    ).length,
    1
  );
});

test("scanner catches whitespace/quote variants and generics", () => {
  for (const form of [
    `db.from( 'performance_records' ) . update( { location_id: x } )`,
    `db.from(\`performance_records\`)\n  .update<{ location_id: string }>({ location_id: x })`,
    `db.from("performance_records")\n  // sneak\n  .update({\n    location_id: x,\n  })`,
  ]) {
    assert.ok(findTransferRewriteOffences(form).length >= 1, form);
  }
});

test("scanner catches uninspectable payloads: variables, calls, spreads", () => {
  for (const form of [
    `db.from("performance_records").update(payload)`,
    `db.from("performance_records").update(makePayload(id, loc))`,
    `db.from("performance_records").update({ ...payload })`,
    `db.from("performance_records").eq("employee_id", id).update(buildIt())`,
  ]) {
    assert.equal(findTransferRewriteOffences(form).length, 1, form);
  }
});

test("scanner survives long chains and string parens without losing the chain", () => {
  const long = `db.from("performance_records")
    .select("${"x,".repeat(300)}id")
    .eq("note", "has (parens) and 'quotes' inside")
    .update({ location_id: loc })`;
  assert.equal(findTransferRewriteOffences(long).length, 1);
});

test("scanner does NOT cross into another table's chain (no false positive)", () => {
  for (const form of [
    `db.from("performance_records").select("id"); db.from("employees").update({ location_id: id })`,
    `const a = db.from("performance_records").select("id");\nconst b = db.from("locations").update({ location_id: z });`,
  ]) {
    assert.equal(findTransferRewriteOffences(form).length, 0, form);
  }
});

test("scanner: Codex round-2 bypasses all caught", () => {
  for (const form of [
    // comment inside the from() call
    `db.from(/* table */ "performance_records").update({ location_id: loc })`,
    // nested template literal with a ')' inside an interpolation
    "db.from(\"performance_records\").eq(\"note\", `outer ${`)`} tail`).update({ location_id: loc })",
    // generic containing an arrow type — its '>' must not close the generic
    `db.from("performance_records").update<{ f: () => string }>({ location_id: loc })`,
    // '{'-prefixed but not a single object literal
    `db.from("performance_records").update({} && payload)`,
    // computed key that could resolve to location_id
    `db.from("performance_records").update({ [key]: loc })`,
    // regex argument containing ')' must not lose the chain
    `db.from("performance_records").eq("x", y.replace(/\\)/g, "")).update({ location_id: z })`,
  ]) {
    assert.ok(findTransferRewriteOffences(form).length >= 1, `must catch: ${form}`);
  }
});

test("scanner: Codex round-2 false-positive guards", () => {
  for (const form of [
    // commented-out code is not an offence
    `// db.from("performance_records").update({ location_id: x })`,
    `/* db.from("performance_records").update({ location_id: x }) */`,
    // '...' inside a string value is not a spread
    `db.from("performance_records").update({ tattle_summary: "Please wait..." })`,
    // a leading comment inside the payload is not "non-literal"
    `db.from("performance_records").update(/* note */ { manager_feedback: text })`,
    // 'location_id' appearing only inside a string value is not an offence
    `db.from("performance_records").update({ note: "location_id stays put" })`,
    // escaped quotes and comments inside intermediate arguments
    `db.from("performance_records").eq("note", "it\\'s (fine)").update({ manager_feedback: t /* why */ })`,
  ]) {
    assert.equal(findTransferRewriteOffences(form).length, 0, `must allow: ${form}`);
  }
});

test("scanner allows today's legitimate writers' shapes (no false positive)", () => {
  for (const form of [
    `db.from("performance_records").update({ manager_feedback: text }).eq("id", performanceRecordId)`,
    `db.from("performance_records").update({ tattle_summary: "No tattles (none).", tattle_summary_generated_at: new Date().toISOString() }).eq("id", id)`,
    `db.from("performance_records").upsert({ employee_id: e, location_id: l, report_period_id: p }, { onConflict: "employee_id,report_period_id,location_id" })`,
    `db.from("performance_records").select("location_id, customer_service_score")`,
  ]) {
    assert.equal(findTransferRewriteOffences(form).length, 0, form);
  }
});
