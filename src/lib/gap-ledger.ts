/**
 * Verdict rules for the Q2 gap-day ledger (Q2 punch-recovery spec REVISED 2,
 * 2026-08-25 §3d + §5b).
 *
 * A "gap day" is a scheduled day with no punch on it from either punch
 * source. Every Q2 2026 gap day gets exactly one verdict; nothing is
 * republished until they all have one.
 *
 * The seeding rules — all computable, in precedence order. §3e-i (BLOCKER,
 * REVISED 2): the ATTENDED SIGNALS run FIRST, on EVERY gap day, before any
 * shape rule — "check the strongest evidence first, or the weakest evidence
 * will close the case before the strongest is consulted." Eleven of the
 * twelve late/none conviction days fall on SIGHTED days; shape-first
 * seeding would have sealed them as absences while a flag in the same
 * database says the person showed up.
 *
 *  0a. LATE/NONE CONVICTION (§3e) → still_unknown, signal attached.
 *      7shifts asserts the person attended and EPD holds no punch — a
 *      confirmed MISSING PUNCH. Outranks every shape rule.
 *  0b. DISCARDED PUNCH (§5b-i) → still_unknown, signal attached. A worked
 *      time_entries row exists on the gap day that the flip stopped
 *      reading (the HOU cutover class, 04-30→05-03: 7shifts punch, no
 *      Toast row, Toast store on/after go-live). Positive evidence of
 *      attendance the scoring path cannot see — and a sharp test case for
 *      every store's cutover boundary week.
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
 *     exactly once — Taggart Dickson, §7a. The WEAKEST evidence in the
 *     ledger, deliberately last: it may only close a day no attended
 *     signal has claimed.
 *
 * Above all of these sits a HUMAN CONFIRMATION (Taggart, §7a) — handled at
 * the route layer, and when it contradicts an attended signal the
 * contradiction is recorded in the evidence rather than silently resolved.
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

/** An attended signal: positive evidence the person worked that day, from
 * a source the scoring path does not read (§3e-i / §5b-i). */
export type AttendedSignal = "late_none" | "discarded_punch";

export interface SeedInput {
  /** YYYY-MM-DD gap day (scheduled, no punch either source). */
  gapDate: string;
  /** Employee row's first punch date ever (v_worked_intervals), or null. */
  firstPunchEver: string | null;
  /** Employee row's last punch date ever (v_worked_intervals), or null. */
  lastPunchEver: string | null;
  /** §3e-i: the attended signal for THIS day, checked before any shape
   * rule ever runs — null when no signal exists. */
  attendedSignal: AttendedSignal | null;
}

export interface SeedVerdict {
  verdict: GapVerdict;
  /** Which rule fired — travels into the evidence column verbatim. */
  reason:
    | "late_none_conviction"
    | "discarded_punch"
    | "after_last_punch"
    | "blind"
    | "sighted";
}

export function seedVerdictForGapDay(input: SeedInput): SeedVerdict {
  const { gapDate, firstPunchEver, lastPunchEver, attendedSignal } = input;
  // §3e-i: attended signals FIRST — they outrank every shape rule. A day
  // with positive evidence of attendance can never seed as absent or as a
  // departure artifact; it is a missing punch until the punch is found.
  if (attendedSignal === "late_none") {
    return { verdict: "still_unknown", reason: "late_none_conviction" };
  }
  if (attendedSignal === "discarded_punch") {
    return { verdict: "still_unknown", reason: "discarded_punch" };
  }
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
  late_none_conviction:
    "§3e conviction: 7shifts marks this shift late/none (attended) and EPD " +
    "holds no punch — confirmed missing punch; outranks every shape rule (§3e-i)",
  discarded_punch:
    "§5b-i: a worked time_entries row exists this day that the flip stopped " +
    "reading (cutover class — 7shifts punch, no Toast row, on/after go-live); " +
    "positive attendance evidence the scoring path cannot see",
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
 * mostly in 7shifts' own data) — and per §3e-i it never contributes to any
 * verdict in either direction. But late/none + no punch in EPD CONVICTS —
 * 7shifts asserts the person attended and EPD cannot see the punch. The
 * day seeds still_unknown (nothing recovered yet) with the signal marking
 * it a confirmed missing punch for the hunt — checked BEFORE any shape
 * rule (§3e-i).
 */
export const LATE_NONE_SIGNAL = "late_none_conviction";
/** §5b-i signal: a punch exists in a source the flip stopped reading. */
export const DISCARDED_PUNCH_SIGNAL = "discarded_punch_at_cutover";
/** Appended when a HUMAN confirmation (Taggart) contradicts an attended
 * signal — recorded, never silently resolved. */
export const SIGNAL_CONTRADICTION_SUFFIX =
  " · ⚠️ an attended signal exists for this day (late/none or discarded " +
  "punch) — contradiction recorded, human confirmation retained";

export function isConvictingStatus(status: string | null | undefined): boolean {
  return status === "late" || status === "none";
}
