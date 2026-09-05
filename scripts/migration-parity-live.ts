/**
 * Migration parity — LIVE mode (W2b). Reads the production migration ledger
 * over an explicitly READ-ONLY connection and compares it to
 * supabase/migrations/*.sql on disk.
 *
 * Run: node scripts/migration-parity-live.ts [--ledger-json <path>]
 *
 * Ledger sources, in order:
 *   1. --ledger-json <path>: a JSON array of {version, name} produced by a
 *      read-only ledger query (e.g. Supabase MCP execute_sql:
 *      `select version, name from supabase_migrations.schema_migrations`).
 *   2. The Supabase Management API (read-only GET
 *      /v1/projects/{ref}/database/migrations) using SUPABASE_ACCESS_TOKEN +
 *      SUPABASE_PROJECT_REF (or the ref parsed from
 *      NEXT_PUBLIC_SUPABASE_URL). No write scope is used; the endpoint is a
 *      GET and this script issues nothing else.
 *
 * Exit states (distinct on purpose — see LIVE_EXIT):
 *   0 clean · 1 findings · 2 SKIPPED, missing credentials (loud, never a
 *   silent pass) · 3 connection/response-shape error.
 *
 * The OFFLINE mode is src/lib/migration-parity.test.ts (CI, fixtures); it
 * never claims live parity, and neither does this script claim anything
 * about function-body equivalence — name↔file matching only, with the
 * ledger's version key reported alongside but never conflated.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  checkMigrationParity,
  formatParityReport,
  liveExitFor,
  LIVE_EXIT,
  type LedgerRow,
} from "../src/lib/migration-parity.ts";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

function fileStems(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
}

function parseLedger(raw: unknown, source: string): LedgerRow[] {
  if (!Array.isArray(raw)) {
    console.error(
      `[migration-parity-live] ${source} did not yield an array — refusing to guess.`
    );
    process.exit(LIVE_EXIT.CONNECTION_OR_SHAPE_ERROR);
  }
  const rows: LedgerRow[] = [];
  for (const item of raw) {
    const version = (item as { version?: unknown })?.version;
    const name = (item as { name?: unknown })?.name;
    if (typeof version !== "string" || typeof name !== "string") {
      console.error(
        `[migration-parity-live] ${source} row lacks string version/name: ${JSON.stringify(item)} — refusing to guess.`
      );
      process.exit(LIVE_EXIT.CONNECTION_OR_SHAPE_ERROR);
    }
    rows.push({ version, name });
  }
  return rows;
}

async function loadLedger(): Promise<{ rows: LedgerRow[]; source: string }> {
  const jsonFlag = process.argv.indexOf("--ledger-json");
  if (jsonFlag !== -1) {
    const path = process.argv[jsonFlag + 1];
    if (!path) {
      console.error("[migration-parity-live] --ledger-json needs a path.");
      process.exit(LIVE_EXIT.CONNECTION_OR_SHAPE_ERROR);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      console.error(
        `[migration-parity-live] could not read/parse ${path}: ${e instanceof Error ? e.message : e}`
      );
      process.exit(LIVE_EXIT.CONNECTION_OR_SHAPE_ERROR);
    }
    return { rows: parseLedger(parsed, path), source: `ledger export ${path}` };
  }

  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref =
    process.env.SUPABASE_PROJECT_REF ??
    process.env.NEXT_PUBLIC_SUPABASE_URL?.match(
      /^https:\/\/([a-z0-9]+)\.supabase\.co/
    )?.[1];

  if (!token || !ref) {
    // LOUD skip with its own exit state — never a silent pass.
    console.error(
      "[migration-parity-live] SKIPPED: live mode needs SUPABASE_ACCESS_TOKEN and " +
        "a project ref (SUPABASE_PROJECT_REF or NEXT_PUBLIC_SUPABASE_URL), or " +
        "--ledger-json <path>. No parity claim is made. Exit " +
        `${LIVE_EXIT.SKIPPED_NO_CREDENTIALS}.`
    );
    process.exit(LIVE_EXIT.SKIPPED_NO_CREDENTIALS);
  }

  const url = `https://api.supabase.com/v1/projects/${ref}/database/migrations`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    console.error(
      `[migration-parity-live] could not reach ${url}: ${e instanceof Error ? e.message : e}`
    );
    process.exit(LIVE_EXIT.CONNECTION_OR_SHAPE_ERROR);
  }
  if (!res.ok) {
    console.error(
      `[migration-parity-live] ${url} answered ${res.status} ${res.statusText}.`
    );
    process.exit(LIVE_EXIT.CONNECTION_OR_SHAPE_ERROR);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    // A malformed body is a connection/shape problem (exit 3) — it must
    // never surface as exit 1, which is reserved for parity findings.
    console.error(
      `[migration-parity-live] ${url} returned an unparseable body: ${e instanceof Error ? e.message : e}`
    );
    process.exit(LIVE_EXIT.CONNECTION_OR_SHAPE_ERROR);
  }
  return {
    rows: parseLedger(body, "management API"),
    source: `management API (read-only GET, project ${ref})`,
  };
}

const { rows, source } = await loadLedger();
const report = checkMigrationParity(fileStems(), rows);
console.log(`[migration-parity-live] LIVE ledger source: ${source}\n`);
console.log(formatParityReport(report));
process.exit(liveExitFor(report));
