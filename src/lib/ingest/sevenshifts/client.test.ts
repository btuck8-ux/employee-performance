/**
 * Unit tests for 7shifts token routing (tokenForCompany).
 *
 * Runs on Node's built-in test runner with native TypeScript type-stripping —
 * no test framework dependency:
 *
 *   node --test src/lib/ingest/sevenshifts/client.test.ts
 *   npm test            # runs every *.test.ts under the ingest path
 *
 * client.ts has zero runtime imports, so type-stripping loads it standalone and
 * the routing is exercised in true isolation. Each test snapshots/restores the
 * three token env vars so the cases don't leak into one another.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenForCompany } from "./client.ts";

const ENV_KEYS = [
  "IKES_CULTUREPULSE",
  "IKES_CULTUREPULSE_HOUSTON",
  "IKES_COLORADO_CULTUREPULSE",
] as const;

const ALL_SET: Record<string, string | undefined> = {
  IKES_CULTUREPULSE_HOUSTON: "hou-tok",
  IKES_CULTUREPULSE: "nola-tok",
  IKES_COLORADO_CULTUREPULSE: "co-tok",
};

function withEnv(values: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const k of ENV_KEYS) {
      if (values[k] === undefined) delete process.env[k];
      else process.env[k] = values[k];
    }
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("Houston 62064 -> IKES_CULTUREPULSE_HOUSTON", () => {
  withEnv(ALL_SET, () => assert.equal(tokenForCompany(62064), "hou-tok"));
});

test("NOLA 360494 -> IKES_CULTUREPULSE", () => {
  withEnv(ALL_SET, () => assert.equal(tokenForCompany(360494), "nola-tok"));
});

test("Colorado 185592 -> IKES_COLORADO_CULTUREPULSE (must not reuse NOLA token)", () => {
  withEnv(ALL_SET, () => {
    assert.equal(tokenForCompany(185592), "co-tok");
    assert.notEqual(tokenForCompany(185592), "nola-tok");
  });
});

test("unknown company_id throws", () => {
  withEnv(ALL_SET, () => {
    assert.throws(() => tokenForCompany(99999), /No 7shifts token route/);
  });
});

test("known company with its env unset throws by env name", () => {
  withEnv(
    { ...ALL_SET, IKES_COLORADO_CULTUREPULSE: undefined },
    () => assert.throws(() => tokenForCompany(185592), /IKES_COLORADO_CULTUREPULSE is not set/)
  );
});
