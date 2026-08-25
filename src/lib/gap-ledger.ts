/**
 * Verdict rules for the Q2 gap-day ledger (Q2 punch-recovery spec REVISED 2,
 * 2026-08-25 §3d + §5b).
 *
 * A "gap day" is a scheduled day with no punch on it from either punch
 * source. Every Q2 2026 gap day gets exactly one verdict; nothing is
 * republished until they all have one.
 *
 * The seeding rules — all computable, in precedence order:
 *
 *  1. AFTER LAST PUNCH EVER → scheduled_after_departure. "A scheduled day
 *     falling after an employee's last punch ever is not an absence. They
 *     were not there to be absent." (§3d — four of four Tucker-confirmed
 *     departures matched this shape; the vacation hypothesis is dead.)
 *     This is a DENOMINATOR ERROR, not a synonym for absent — the metric
 *     treatment is a separate, unasked Tucker decision.
 *  2. BLIND (no punch from this person by that date) → still_unknown. The
 *     feed was not in a position to see them; the likely reading is missing
 *     data, and the absence of a punch must never be its own evidence of
 *     absence (§9 — the circularity this sprint exists to break).
 *  3. SIGHTED (the feed held this person's punches by that date and
 *     recorded nothing that day) → confirmed_absent. Validated externally
 *     exactly once — Taggart Dickson, §7a — so the report keeps the rule's
 *     name in the evidence for later auditability.
 *
 * Punch history is per EMPLOYEE ROW, not per person: six people carry two
 * employee rows sharing one seven_shifts_user_id (§4a), and EPD measured
 * that split identity does NOT explain the gaps (Keara Beck: zero of 23
 * days on her other row). The ledger keys on employees.id.
 *
 * ⚠️ THE MEASUREMENT TRAP that produced this revision (§0): time_entries
 * holds BOTH schedule and punch rows. Any punch-history query must filter
 * entry_type='worked' — or better, read v_worked_intervals, which is the
 * era-correct union of both punch sources (§3b) and can't include schedule
 * rows by construction. An unfiltered count credited Chazz Limon — zero
 * punches ever — with 54 worked days.
 */

export type GapVerdict =
  | "punch_recovered"
  | "confirmed_absent"
  | "scheduled_after_departure"
  | "still_unknown";

export interface SeedInput {
  /** YYYY-MM-DD gap day (scheduled, no punch either source). */
  gapDate: string;
  /** Employee row's first punch date ever (v_worked_intervals), or null. */
  firstPunchEver: string | null;
  /** Employee row's last punch date ever (v_worked_intervals), or null. */
  lastPunchEver: string | null;
}

export interface SeedVerdict {
  verdict: GapVerdict;
  /** Which rule fired — travels into the evidence column verbatim. */
  reason: "after_last_punch" | "blind" | "sighted";
}

export function seedVerdictForGapDay(input: SeedInput): SeedVerdict {
  const { gapDate, firstPunchEver, lastPunchEver } = input;
  if (lastPunchEver !== null && gapDate > lastPunchEver) {
    return { verdict: "scheduled_after_departure", reason: "after_last_punch" };
  }
  if (firstPunchEver === null || gapDate < firstPunchEver) {
    return { verdict: "still_unknown", reason: "blind" };
  }
  return { verdict: "confirmed_absent", reason: "sighted" };
}

/** Evidence strings — stated once so the ledger reads uniformly. */
export const SEED_EVIDENCE: Record<SeedVerdict["reason"], string> = {
  after_last_punch:
    "scheduled after this employee's last punch ever (§3d) — 4 of 9 Q2 cases " +
    "confirmed by Tucker 2026-08-25 as departures; the rest are candidates (§7b)",
  blind:
    "blind: EPD had received no punch from this employee by this date — the " +
    "feed was not in a position to see them; missing data until proven otherwise",
  sighted:
    "sighted: the feed was receiving this employee's punches by this date and " +
    "recorded nothing this day — read as a real absence (§3d; validated on §7a)",
};

/**
 * §7a — Taggart Dickson, the one human-confirmed absence. Same verdict the
 * sighted rule produces; richer evidence, keyed on his 7shifts user id so
 * the seeding never matches on a name.
 */
export const TAGGART_SEVEN_SHIFTS_USER_ID = 9867936;
export const TAGGART_EVIDENCE =
  "confirmed by Tucker 2026-08-25: college term, returned for summer (§7a) — " +
  "out of recovery scope entirely";

/**
 * §3e — the late/none conviction. 7shifts' attendance_status is a claim,
 * not a fact: no_show does NOT acquit (51% of June no_shows have a punch,
 * mostly in 7shifts' own data). But late/none + no punch in EPD CONVICTS —
 * 7shifts asserts the person attended and EPD cannot see the punch. The
 * day stays still_unknown (nothing recovered yet); the signal marks it a
 * confirmed missing punch for the hunt.
 */
export const LATE_NONE_SIGNAL = "late_none_conviction";
export const LATE_NONE_EVIDENCE_SUFFIX =
  " · §3e conviction: 7shifts marks this shift late/none (attended) and EPD " +
  "holds no punch — confirmed missing punch";

export function isConvictingStatus(status: string | null | undefined): boolean {
  return status === "late" || status === "none";
}
