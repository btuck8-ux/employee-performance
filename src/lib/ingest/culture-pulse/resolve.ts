/**
 * CP member → EPD employee resolution (pure; unit-tested standalone).
 *
 * Match precedence (handoff-cp-survey-feed-EXECUTE-2026-07-26.md §4b):
 *   1. (location, employee_code) — primary. The identity artery (2026-07-20)
 *      populated CP employee_directory.employee_code with the EPD code, so
 *      this is unambiguous and durable.
 *   2. (location, name) via the same fuzzyMatchEmployee the manual survey
 *      import uses — covers CP rows whose employee_code is still null (a
 *      not-yet-synced hire).
 *   3. Unresolvable → skip with a logged warning; never fabricate.
 *
 * NEVER match by raw email across systems: CP emails ≠ EPD emails for several
 * people (the §1 list). Email is only used CP-side to join the send log to
 * CP's own directory.
 */

// Explicit .ts extension so Node's type-stripping test runner can resolve it
// when resolve.test.ts loads this file standalone (allowImportingTsExtensions).
import {
  fuzzyMatchEmployee,
  type EmployeeCandidate,
} from "../../fuzzy-match-employee.ts";

/** One person in one CP survey week (sent and/or completed). */
export interface CpMember {
  name: string | null;
  email: string | null;
  /** EPD employee_code carried by CP's directory (identity artery). */
  employee_code: string | null;
  completed: boolean;
  /** YYYY-MM-DD (from finished_at) when completed. */
  completion_date: string | null;
}

/** One CP target_monday for one location, members deduped. */
export interface CpSurveyWeek {
  target_monday: string; // YYYY-MM-DD
  members: CpMember[];
  /** True for pre-automation weeks (~before 2026-05-18) with no send log —
   * the pool is responder-derived and flagged in the run detail. */
  sends_missing: boolean;
}

export interface EpdRosterEmployee {
  id: string;
  employee_name: string;
  employee_code: string | null;
}

export type ResolveVia = "code" | "name" | "ambiguous" | "none";

export interface ResolveResult {
  employee_id: string | null;
  via: ResolveVia;
}

export interface RosterIndex {
  byCode: Map<string, string>; // employee_code -> employee id
  candidates: EmployeeCandidate[];
}

export function buildRosterIndex(roster: EpdRosterEmployee[]): RosterIndex {
  const byCode = new Map<string, string>();
  for (const e of roster) {
    if (e.employee_code) byCode.set(e.employee_code.trim().toLowerCase(), e.id);
  }
  return {
    byCode,
    candidates: roster.map((e) => ({ id: e.id, employee_name: e.employee_name })),
  };
}

export function resolveCpMember(
  member: CpMember,
  roster: RosterIndex
): ResolveResult {
  if (member.employee_code) {
    const id = roster.byCode.get(member.employee_code.trim().toLowerCase());
    if (id) return { employee_id: id, via: "code" };
  }
  if (member.name) {
    const r = fuzzyMatchEmployee(member.name, roster.candidates);
    if (r.match) return { employee_id: r.match.id, via: "name" };
    if (r.confidence === "ambiguous") return { employee_id: null, via: "ambiguous" };
  }
  return { employee_id: null, via: "none" };
}
