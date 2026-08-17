/**
 * Pin: every /api/cron/* route sends the fatal alert from its top-level
 * catch (hardening chip, 2026-08-17).
 *
 * Proven 2026-08-14: a transient Supabase outage 500'd three crons at their
 * FIRST DB call — before startRun — so zero ingest_runs rows existed and the
 * run-outcome alert (alert.ts decideAlert path) was blind; Vercel logs were
 * the only evidence. Each cron route's catch now calls sendFatalAlert(route,
 * message), which emails via the same env-gated Resend path and deliberately
 * writes nothing to ingest_runs. This TEXT-LEVEL pin keeps new cron routes
 * from shipping without the coverage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const cronDir = join(process.cwd(), "src/app/api/cron");
const routes = readdirSync(cronDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

test("cron route inventory is non-empty (sanity)", () => {
  assert.ok(routes.length >= 7, `expected ≥7 cron routes, found ${routes.length}`);
});

for (const route of routes) {
  test(`/api/cron/${route} wires the fatal alert into its catch`, () => {
    const src = readFileSync(join(cronDir, route, "route.ts"), "utf8");
    assert.match(
      src,
      /import \{ sendFatalAlert \} from "@\/lib\/ingest\/sevenshifts\/alert"/,
      "imports sendFatalAlert"
    );
    assert.match(
      src,
      new RegExp(`await sendFatalAlert\\("/api/cron/${route}",`),
      "catch calls sendFatalAlert with its own route path"
    );
    assert.match(src, /catch \(err\)/, "has a top-level catch");
  });
}
