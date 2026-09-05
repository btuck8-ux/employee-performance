/**
 * W4 frozen-set drift detector — the packet's full failure-mode matrix.
 * Every case produces a DISTINCT visible outcome; none may pass silently.
 * The production check is authoritative; the migration writer scan at the
 * bottom is the secondary heuristic with fixtures for the actual writer
 * forms.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  EXPECTED_FROZEN_LABELS,
  judgeFrozenSet,
  buildFrozenDriftBody,
  runFrozenDriftCheck,
  sqlWritesFrozen,
  type FrozenDriftResult,
} from "./frozen-drift.ts";
import type { AdminClient } from "./sevenshifts/crosswalk";
import type { AlertResult } from "./alert-email.ts";

const OBLIGATION =
  /If this change is intended, the change-notice to both partners must precede it\./;

// ---- the pure judge: one distinct problem per deviation ----

test("clean set: exactly Q3 2025 and Q4 2025, one row each", () => {
  const v = judgeFrozenSet(["Q3 2025", "Q4 2025"]);
  assert.equal(v.drift, false);
  assert.deepEqual(v.problems, []);
  assert.equal(v.totalRows, 2);
});

test("missing period is its own problem kind", () => {
  const v = judgeFrozenSet(["Q3 2025"]);
  assert.equal(v.drift, true);
  assert.deepEqual(v.problems, [
    { kind: "missing_label", label: "Q4 2025", rows: 0 },
  ]);
});

test("extra period (unexpected label) is its own problem kind", () => {
  const v = judgeFrozenSet(["Q3 2025", "Q4 2025", "Q1 2026"]);
  assert.equal(v.drift, true);
  assert.deepEqual(v.problems, [
    { kind: "unexpected_label", label: "Q1 2026", rows: 1 },
  ]);
});

test("DUPLICATE LABEL is caught — the case a set comparison conceals", () => {
  // ['Q3 2025','Q3 2025','Q4 2025'] as a SET equals the expected set; the
  // judge must still flag it because it counts rows per label.
  const v = judgeFrozenSet(["Q3 2025", "Q3 2025", "Q4 2025"]);
  assert.equal(v.drift, true);
  assert.deepEqual(v.problems, [
    { kind: "duplicate_label", label: "Q3 2025", rows: 2 },
  ]);
});

test("unexpected label alone (wrong quarter frozen)", () => {
  const v = judgeFrozenSet(["Q3 2025", "Q1 2026"]);
  assert.equal(v.drift, true);
  assert.deepEqual(
    v.problems.map((p) => p.kind).sort(),
    ["missing_label", "unexpected_label"]
  );
});

test("empty frozen set: both labels missing, distinctly", () => {
  const v = judgeFrozenSet([]);
  assert.equal(v.drift, true);
  assert.deepEqual(
    v.problems,
    EXPECTED_FROZEN_LABELS.map((label) => ({
      kind: "missing_label" as const,
      label,
      rows: 0,
    }))
  );
});

test("the failure message carries the partner obligation verbatim", () => {
  const body = buildFrozenDriftBody(judgeFrozenSet(["Q3 2025", "Q3 2025", "Q4 2025"]));
  assert.match(body, /report_periods\.frozen holds 3 rows/);
  assert.match(body, /'Q3 2025' × 2, 'Q4 2025' × 1/);
  assert.match(
    body,
    /EPD's contract with Culture Pulse and Training HQ states exactly Q3 2025 and Q4 2025, one row each/
  );
  assert.match(body, OBLIGATION);
  assert.match(body, /duplicate_label/);
});

// ---- the runner: read failure and alert delivery failure are distinct,
// visible outcomes; nothing passes silently ----

type SendCall = { subject: string; body: string; label: string };

function fakeClient(result: { data?: Array<{ label: string }>; error?: { message: string } }): AdminClient {
  // Asserts the QUERY, not just the result path (Codex nit): the check must
  // read report_periods.label where frozen = true or it isn't the check.
  return {
    from: (table: string) => {
      assert.equal(table, "report_periods");
      return {
        select: (cols: string) => {
          assert.equal(cols, "label");
          return {
            eq: async (col: string, val: unknown) => {
              assert.equal(col, "frozen");
              assert.equal(val, true);
              return result;
            },
          };
        },
      };
    },
  } as unknown as AdminClient;
}

function fakeSender(sent: boolean, calls: SendCall[]) {
  return async (subject: string, body: string, label: string): Promise<AlertResult> => {
    calls.push({ subject, body, label });
    return { sent, reason: sent ? "sent via resend" : "resend 500" };
  };
}

test("runner: clean set → status clean, no alert", async () => {
  const calls: SendCall[] = [];
  const r = await runFrozenDriftCheck(
    fakeClient({ data: [{ label: "Q3 2025" }, { label: "Q4 2025" }] }),
    fakeSender(true, calls)
  );
  assert.equal(r.status, "clean");
  assert.equal(r.alert, null);
  assert.equal(calls.length, 0);
});

test("runner: drift → status drift with its OWN alert reason/label", async () => {
  const calls: SendCall[] = [];
  const r = await runFrozenDriftCheck(
    fakeClient({ data: [{ label: "Q3 2025" }] }),
    fakeSender(true, calls)
  );
  assert.equal(r.status, "drift");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, "frozen-drift");
  assert.match(calls[0].subject, /FROZEN-SET DRIFT/);
  assert.match(calls[0].body, OBLIGATION);
  assert.equal(r.alert?.sent, true);
});

test("runner: DATABASE READ FAILURE is read_error + alert — never clean, never a throw", async () => {
  const calls: SendCall[] = [];
  const r: FrozenDriftResult = await runFrozenDriftCheck(
    fakeClient({ error: { message: "connection refused" } }),
    fakeSender(true, calls)
  );
  assert.equal(r.status, "read_error");
  assert.equal(r.verdict, null);
  assert.match(r.readError ?? "", /connection refused/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].subject, /COULD NOT READ/);
  assert.match(calls[0].body, /NOT a clean result/);
});

test("runner: ALERT DELIVERY FAILURE stays visible on the result", async () => {
  const calls: SendCall[] = [];
  const r = await runFrozenDriftCheck(
    fakeClient({ data: [{ label: "Q3 2025" }, { label: "Q4 2025" }, { label: "Q4 2025" }] }),
    fakeSender(false, calls)
  );
  assert.equal(r.status, "drift"); // the finding does not depend on email
  assert.equal(r.alert?.sent, false);
  assert.match(r.alert?.reason ?? "", /resend 500/);
});

// ---- route composition pins: independence of the two detectors ----

const routeSrc = readFileSync(
  join(process.cwd(), "src/app/api/cron/recompute-failure-sweep/route.ts"),
  "utf8"
);

test("route: frozen check runs OUTSIDE the sweep's try/catch — a sweep fatal cannot skip it", () => {
  const catchIdx = routeSrc.indexOf("sweepError =");
  const frozenIdx = routeSrc.indexOf("runFrozenDriftCheck(supabase)");
  assert.ok(catchIdx > 0 && frozenIdx > catchIdx, "frozen check must follow the sweep catch, unconditionally");
  assert.doesNotMatch(
    routeSrc.slice(frozenIdx - 200, frozenIdx),
    /if\s*\(\s*sweep[^)]*\)\s*\{[^}]*$/,
    "frozen check must not be gated on the sweep result"
  );
});

test("route: frozen drift is its own response field, never merged into the sweep summary", () => {
  assert.match(routeSrc, /frozenDrift: frozen/);
  assert.doesNotMatch(routeSrc, /summary\.shouldAlert\s*=|shouldAlert\s*\|\|/);
});

test("route: the frozen check is not gated on ingest activity", () => {
  // No conditional between the sweep block and the frozen CALL reads
  // sweptRuns/rows/ingest counts. Anchor the call search AFTER the marker
  // so the import line cannot satisfy it (Codex should-fix: the previous
  // form compared against an empty slice).
  const start = routeSrc.indexOf("Detector 2");
  const callIdx = routeSrc.indexOf("runFrozenDriftCheck(supabase)", start);
  assert.ok(start > 0 && callIdx > start, "Detector 2 marker must precede the call");
  const between = routeSrc.slice(start, callIdx);
  assert.ok(between.length > 0, "slice must be non-empty");
  assert.doesNotMatch(between, /sweptRuns|rows\.length|ingest_runs|if\s*\(\s*sweep/);
});

test("route: client construction failure alerts fatally and answers 500 (never an unreported throw)", () => {
  const initIdx = routeSrc.indexOf("supabase = createAdminClient()");
  const catchIdx = routeSrc.indexOf("client init fatal");
  assert.ok(initIdx > 0 && catchIdx > initIdx, "createAdminClient must sit in its own guarded block");
  assert.match(routeSrc.slice(catchIdx, catchIdx + 400), /sendFatalAlert/);
  assert.match(routeSrc.slice(catchIdx, catchIdx + 400), /status: 500/);
});

// ---- secondary heuristic: the migration writer scan ----

test("writer-form fixtures: set / default / insert all detected", () => {
  assert.equal(sqlWritesFrozen(`update public.report_periods set frozen = true where label = 'Q3 2025';`), true);
  assert.equal(sqlWritesFrozen(`alter table report_periods add column frozen boolean not null default true;`), true);
  assert.equal(
    sqlWritesFrozen(`insert into public.report_periods (label, year, quarter, period_start, period_end, frozen) values ('Q3 2025', 2025, 3, '2025-07-01', '2025-09-30', true);`),
    true
  );
});

test("reader forms do NOT count as writers", () => {
  assert.equal(sqlWritesFrozen(`select label from report_periods where frozen;`), false);
  assert.equal(sqlWritesFrozen(`case when rp.frozen then rp.period_start else greatest(...) end`), false);
  assert.equal(sqlWritesFrozen(`-- set frozen = true (comment only)`), false);
  assert.equal(sqlWritesFrozen(`create policy p on report_periods using (frozen = false);`), false);
});

test("writer scan: Codex CP2 hardening cases", () => {
  // multi-column SET list — frozen not first
  assert.equal(
    sqlWritesFrozen(`update report_periods set label = label, frozen = false where quarter = 3;`),
    true
  );
  // block-commented write is NOT a writer
  assert.equal(sqlWritesFrozen(`/* update report_periods set frozen = true; */ select 1;`), false);
  // another table's frozen column is NOT a report_periods writer
  assert.equal(sqlWritesFrozen(`update other_table set frozen = true;`), false);
  // schema-qualified + ONLY forms still caught
  assert.equal(sqlWritesFrozen(`update only public.report_periods set frozen = true;`), true);
});

test("writer scan: Codex final-round cases (case, SET-list bounds, DDL scope)", () => {
  // uppercase assignment caught
  assert.equal(sqlWritesFrozen(`UPDATE report_periods SET FROZEN = false;`), true);
  // frozen in the WHERE predicate is a READ, not a write
  assert.equal(sqlWritesFrozen(`UPDATE report_periods SET label = label WHERE frozen = true;`), false);
  // another table's frozen column default is not this contract's business
  assert.equal(
    sqlWritesFrozen(`ALTER TABLE other_table ADD COLUMN frozen boolean DEFAULT false;`),
    false
  );
  // report_periods' own DDL default IS a writer (063's actual form)
  assert.equal(
    sqlWritesFrozen(`alter table public.report_periods add column frozen boolean not null default false;`),
    true
  );
});

test("across ALL migrations, only 063 writes frozen (secondary heuristic; prod check stays authoritative)", () => {
  const dir = join(process.cwd(), "supabase", "migrations");
  const writers: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".sql")) continue;
    if (sqlWritesFrozen(readFileSync(join(dir, f), "utf8"))) writers.push(f);
  }
  assert.deepEqual(writers, ["063_report_periods_frozen.sql"]);
});
