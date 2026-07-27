/**
 * Unit tests for CP member -> EPD employee resolution.
 *
 * Runs on Node's built-in test runner with native TypeScript type-stripping
 * (npm test). resolve.ts imports only fuzzy-match-employee.ts (dependency-
 * free), so it loads standalone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRosterIndex,
  resolveCpMember,
  type CpMember,
  type EpdRosterEmployee,
} from "./resolve.ts";

const ROSTER: EpdRosterEmployee[] = [
  { id: "e-1", employee_name: "Juan Carlos Ortega", employee_code: "IKE-001" },
  { id: "e-2", employee_name: "Jose Mena", employee_code: "IKE-002" },
  { id: "e-3", employee_name: "Khy'li Haynes", employee_code: null },
  { id: "e-4", employee_name: "Maria Garcia", employee_code: "IKE-004" },
  { id: "e-5", employee_name: "Maria Lopez", employee_code: "IKE-005" },
];

const INDEX = buildRosterIndex(ROSTER);

function member(overrides: Partial<CpMember>): CpMember {
  return {
    name: null,
    email: null,
    employee_code: null,
    completed: false,
    completion_date: null,
    ...overrides,
  };
}

test("employee_code wins even when the CP name would fuzzy-match someone else", () => {
  // CP emails/names can drift; the code is the durable key.
  const r = resolveCpMember(
    member({ name: "Jose M.", employee_code: "IKE-001" }),
    INDEX
  );
  assert.deepEqual(r, { employee_id: "e-1", via: "code" });
});

test("code matching is case/whitespace tolerant", () => {
  const r = resolveCpMember(member({ employee_code: "  ike-002 " }), INDEX);
  assert.deepEqual(r, { employee_id: "e-2", via: "code" });
});

test("null code falls back to fuzzy name match", () => {
  const r = resolveCpMember(member({ name: "khyli haynes" }), INDEX);
  assert.equal(r.employee_id, "e-3");
  assert.equal(r.via, "name");
});

test("unknown code with no name resolves to none — never fabricate", () => {
  const r = resolveCpMember(member({ employee_code: "IKE-999" }), INDEX);
  assert.deepEqual(r, { employee_id: null, via: "none" });
});

test("unknown code with a resolvable name falls through to the name", () => {
  // A stale/unsynced code shouldn't lose a person the roster clearly has.
  const r = resolveCpMember(
    member({ name: "Juan Carlos Ortega", employee_code: "IKE-999" }),
    INDEX
  );
  assert.deepEqual(r, { employee_id: "e-1", via: "name" });
});

test("ambiguous first name is reported, not guessed", () => {
  const r = resolveCpMember(member({ name: "Maria" }), INDEX);
  assert.deepEqual(r, { employee_id: null, via: "ambiguous" });
});

test("email is never used as a cross-system match key", () => {
  // Same email as nobody in EPD; only email present -> none.
  const r = resolveCpMember(
    member({ email: "someone@gmail.com" }),
    INDEX
  );
  assert.deepEqual(r, { employee_id: null, via: "none" });
});
