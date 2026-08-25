/**
 * Pure logic for the Toast Labor worked-time feed (workstream I, Tucker's
 * rulings 2026-08-23) — everything here is IO-free and unit-tested in
 * labor-core.test.ts. The IO shell is labor.ts.
 *
 * Identity doctrine (ruling §1a + §4):
 *  - The crosswalk anchors on EPD's employees.id, NEVER via
 *    seven_shifts_user_id (7shifts is on a removal path).
 *  - Email equality (Toast login ↔ EPD email) is deterministic → auto-commit,
 *    but ONLY when exactly one EPD employee at that store carries the email
 *    and the Toast guid isn't already mapped.
 *  - Behavioural matching (punch-dates vs scheduled-days agreement) is
 *    legitimate evidence — schedule (7shifts) and punch (Toast) are
 *    measurements from UNCONNECTED systems, unlike the circular no_show flag
 *    — but a wrong auto-commit silently attributes one person's work to
 *    another, so it auto-commits only on an unambiguous match (thresholds
 *    below, also stated in the PR body). Ambiguity queues for SA review.
 *  - NAME MATCHING IS FORBIDDEN as a match path (Ryan Griffin ≠ Connor
 *    Griffin; Amy Roberts ≠ Amy Segelhorst). Names are display-only hints in
 *    the triage UI; nothing in this module reads a name field. Pinned by
 *    test.
 */

/** Minimum distinct punch-days overlapping the candidate's scheduled days
 * before an auto-commit is even considered (ruling §4 guard 1). */
// ⚠️ A discriminator is only as strong as the VARIANCE in the thing it
// discriminates on (6c62e9c8, 2026-08-25): every HRANCH employee is
// scheduled at 15:00, so clock-in proximity — the signal that settled every
// earlier case — collapsed to three candidates inside five minutes. That is
// the Houston day-overlap failure one level up. Where scheduled starts do
// not vary, mutual exclusion (below) is the discriminator that still works:
// a candidate already punched in on their OWN account cannot be the
// disputed one.
export const BEHAVIOURAL_MIN_OVERLAP_DAYS = 6;
/**
 * §5b (defect 2026-08-24): clock-in proximity is REQUIRED, not advisory. No
 * auto-commit where the median |clock-in − scheduled start| exceeds this.
 * Set from the live distribution, not adopted from the defect note: the 26
 * corroborated matches' worst median was 45.3 min and every other row sat
 * ≤ 45; the two wrong/suspect attributions measured 124 and 302 min. 60
 * splits the clusters with headroom on both sides.
 */
export const TIME_CEILING_MIN = 60;
/**
 * §5b ranking guard: when two eligible candidates' medians are within this
 * many minutes, the time signal cannot separate them — ambiguous, queue.
 * Correct-vs-wrong separations measured ≥ 60 min; same-schedule colleagues
 * (the Griffin case) separated by well over this.
 */
export const TIME_RUNNER_UP_MARGIN_MIN = 15;
/** §5c audit: rows with fewer paired days than this yield too noisy a
 * median to flag on. */
export const AUDIT_MIN_PAIRED_DAYS = 5;

/** A Toast /labor/v1/timeEntries row (probe-verified field list). */
export interface RawToastTimeEntry {
  guid?: unknown;
  businessDate?: unknown;
  inDate?: unknown;
  outDate?: unknown;
  regularHours?: unknown;
  overtimeHours?: unknown;
  autoClockedOut?: unknown;
  deleted?: unknown;
  deletedDate?: unknown;
  employeeReference?: { guid?: unknown } | null;
  jobReference?: { guid?: unknown } | null;
  [key: string]: unknown;
}

/** A Toast /labor/v1/employees row — identity fields only; name fields exist
 * on the wire but are deliberately absent here so nothing downstream can
 * match on them. */
export interface RawToastEmployee {
  guid?: unknown;
  email?: unknown;
  deleted?: unknown;
  [key: string]: unknown;
}

export interface PunchUpsertRow {
  toast_time_entry_guid: string;
  location_id: string;
  toast_employee_guid: string;
  employee_id: string | null;
  entry_date: string;
  in_at: string;
  out_at: string | null;
  regular_hours: number | null;
  overtime_hours: number | null;
  job_reference_guid: string | null;
  auto_clocked_out: boolean | null;
  deleted: boolean;
  deleted_at: string | null;
  raw: Record<string, unknown>;
  last_seen_upstream_at: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Toast's 1970-01-01 epoch placeholder means "not deleted". */
function realTimestamp(v: unknown): string | null {
  const s = str(v);
  if (!s || s.startsWith("1970-01-01")) return null;
  return s;
}

/** Normalize Toast's businessDate (yyyyMMdd number/string, or ISO) to
 * YYYY-MM-DD; falls back to the inDate prefix (UTC caveat — overnight shifts
 * near midnight UTC could straddle a day; businessDate is store-local and
 * always preferred). */
export function normalizeBusinessDate(entry: RawToastTimeEntry): string | null {
  const bd = entry.businessDate;
  if (typeof bd === "number" || typeof bd === "string") {
    const s = String(bd);
    if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  }
  const inDate = entry.inDate;
  if (typeof inDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(inDate)) {
    return inDate.slice(0, 10);
  }
  return null;
}

export interface ClassifiedPunches {
  rows: PunchUpsertRow[];
  /** Distinct entry_dates per UNMATCHED toast_employee_guid — the
   * behavioural matcher's evidence and the triage queue's signal. */
  unmatchedPunchDates: Map<string, Set<string>>;
  skippedNoGuid: number;
  skippedNoDate: number;
  skippedNoIn: number;
}

/**
 * Normalize a pulled window of time entries into upsert rows, attributing
 * employee_id through the crosswalk (toast_employee_guid → employee_id).
 * Punches from unmatched guids are STORED with employee_id null — they must
 * exist for the matcher and the queue; dropping them would hide exactly the
 * people this feed exists to fix.
 */
export function classifyPunches(
  entries: RawToastTimeEntry[],
  locationId: string,
  crosswalk: Map<string, string>,
  nowIso: string
): ClassifiedPunches {
  const rows: PunchUpsertRow[] = [];
  const unmatchedPunchDates = new Map<string, Set<string>>();
  let skippedNoGuid = 0;
  let skippedNoDate = 0;
  let skippedNoIn = 0;

  for (const e of entries) {
    const guid = str(e.guid);
    const empGuid = str(e.employeeReference?.guid);
    if (!guid || !empGuid) {
      skippedNoGuid += 1;
      continue;
    }
    const entryDate = normalizeBusinessDate(e);
    if (!entryDate) {
      skippedNoDate += 1;
      continue;
    }
    const inAt = str(e.inDate);
    if (!inAt) {
      skippedNoIn += 1;
      continue;
    }
    const employeeId = crosswalk.get(empGuid) ?? null;
    if (employeeId === null) {
      const set = unmatchedPunchDates.get(empGuid) ?? new Set<string>();
      set.add(entryDate);
      unmatchedPunchDates.set(empGuid, set);
    }
    rows.push({
      toast_time_entry_guid: guid,
      location_id: locationId,
      toast_employee_guid: empGuid,
      employee_id: employeeId,
      entry_date: entryDate,
      in_at: inAt,
      out_at: str(e.outDate),
      regular_hours: num(e.regularHours),
      overtime_hours: num(e.overtimeHours),
      job_reference_guid: str(e.jobReference?.guid),
      auto_clocked_out: typeof e.autoClockedOut === "boolean" ? e.autoClockedOut : null,
      deleted: e.deleted === true,
      deleted_at: realTimestamp(e.deletedDate),
      raw: e as Record<string, unknown>,
      last_seen_upstream_at: nowIso,
    });
  }
  return { rows, unmatchedPunchDates, skippedNoGuid, skippedNoDate, skippedNoIn };
}

export interface EmailSeed {
  toast_employee_guid: string;
  employee_id: string;
}

export interface EmailSeedPlan {
  seeds: EmailSeed[];
  /** Toast emails matching MORE than one EPD employee at the store — never
   * auto-committed; they queue for SA review. */
  ambiguousEmails: number;
}

/**
 * Plan the deterministic email seeding for one store (ruling §4 path 1).
 * A seed requires: Toast email present, exactly ONE EPD employee at the
 * store with that email, and the guid not already crosswalked. The same EPD
 * employee MAY legitimately receive several guids (deleted/recreated Toast
 * accounts both carrying the login email).
 */
export function planEmailSeeds(
  toastEmployees: RawToastEmployee[],
  epdEmployees: Array<{ id: string; email: string | null }>,
  alreadyMappedGuids: Set<string>
): EmailSeedPlan {
  const byEmail = new Map<string, string[]>();
  for (const e of epdEmployees) {
    if (typeof e.email !== "string" || !e.email.trim()) continue;
    const key = e.email.trim().toLowerCase();
    byEmail.set(key, [...(byEmail.get(key) ?? []), e.id]);
  }
  const seeds: EmailSeed[] = [];
  let ambiguousEmails = 0;
  for (const te of toastEmployees) {
    const guid = str(te.guid);
    const email = str(te.email)?.toLowerCase();
    if (!guid || !email || alreadyMappedGuids.has(guid)) continue;
    const candidates = byEmail.get(email) ?? [];
    if (candidates.length === 1) {
      seeds.push({ toast_employee_guid: guid, employee_id: candidates[0] });
    } else if (candidates.length > 1) {
      ambiguousEmails += 1;
    }
  }
  return { seeds, ambiguousEmails };
}

/**
 * Median |punch clock-in − scheduled start| in minutes over the dates both
 * maps share. Timestamps are absolute (timestamptz ISO), so the difference
 * needs no timezone conversion; pairing rides the store-local dates both
 * sides already carry (Toast businessDate / 7shifts entry_date).
 */
export function medianAbsDeltaMinutes(
  punchInByDate: Map<string, string>,
  scheduleStartByDate: Map<string, string>
): { paired_days: number; median_min: number | null } {
  const deltas: number[] = [];
  for (const [date, inAt] of punchInByDate) {
    const startAt = scheduleStartByDate.get(date);
    if (!startAt) continue;
    const delta = Math.abs(Date.parse(inAt) - Date.parse(startAt)) / 60000;
    if (Number.isFinite(delta)) deltas.push(delta);
  }
  if (deltas.length === 0) return { paired_days: 0, median_min: null };
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  const median =
    deltas.length % 2 === 1 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
  return { paired_days: deltas.length, median_min: median };
}

export interface TimeAwareCandidate {
  employee_id: string;
  /** Store-local date -> earliest scheduled start (timestamptz ISO). */
  scheduleStartByDate: Map<string, string>;
  /** Dates this candidate already punched via their OWN mapped GUID(s) —
   * the mutual-exclusion evidence (spec 2026-08-25 §5b). A person clocked
   * in on their own account cannot simultaneously be the disputed account
   * that day. (A genuine dual-account punching BOTH the same day would be
   * wrongly excluded from AUTO-candidacy — physically near-impossible, and
   * the SA manual path remains for exactly that shape.) */
  ownPunchDays?: Set<string>;
}

export interface TimeAwareScore {
  employee_id: string;
  overlap_days: number;
  median_clockin_delta_min: number | null;
}

export interface TimeAwareVerdict {
  decision: "auto" | "ambiguous" | "insufficient";
  best: TimeAwareScore | null;
  runner_up: TimeAwareScore | null;
  punch_days: number;
  /** §5d: a null runner-up must be distinguishable from a walkover — pool
   * size and eligible count travel with every verdict. */
  candidate_pool_size: number;
  eligible_count: number;
  /** §5b mutual exclusion (2026-08-25): candidates eliminated because they
   * were already punched in on their own account on one of the disputed
   * GUID's punch days. Travels as evidence — an exclusion is a claim. */
  mutually_excluded_count: number;
}

/**
 * Time-aware behavioural scorer (defect 2026-08-24 §5b — replaces the
 * day-overlap-only scorer whose CPD mis-attribution triggered the defect).
 *
 * Eligibility: overlap ≥ BEHAVIOURAL_MIN_OVERLAP_DAYS (the day floor keeps
 * the median meaningful) AND median clock-in delta ≤ TIME_CEILING_MIN (a
 * person clocks in near their scheduled start; 124-min and 302-min medians
 * are the measured signatures of wrong attributions).
 *
 * Ranking: TIME WINS. Day overlap barely separates anyone at stores where
 * most of the roster works most days (HOU: 13 of 14 ≥24 of ~55 days);
 * clock-in proximity separated every measured case cleanly. Where the two
 * eligible medians sit within TIME_RUNNER_UP_MARGIN_MIN of each other the
 * signal can't tell them apart — ambiguous, queue for SA.
 *
 * Candidates are the CALLER's responsibility to restrict to the same store
 * and to §5a's eligibility (an employee is blocked only by a mapping that
 * actually carries punches — a zero-punch mapping must not hide the true
 * owner, which is exactly how the CPD mis-attribution happened).
 */
export function scoreTimeAwareMatch(
  punchInByDate: Map<string, string>,
  candidates: TimeAwareCandidate[]
): TimeAwareVerdict {
  // MUTUAL EXCLUSION (spec 2026-08-25 §5b) — applied before any scoring:
  // a candidate with a punch on one of the disputed GUID's punch days from
  // a DIFFERENT (their own) GUID cannot be this GUID. This is the
  // discriminator that still works where scheduled-start variance
  // collapses (every HRANCH start is 15:00): it resolved 6c62e9c8 — both
  // rivals were punched in on their own accounts, one 26 seconds apart.
  const disputedDays = [...punchInByDate.keys()];
  const contenders = candidates.filter(
    (c) => !c.ownPunchDays || !disputedDays.some((d) => c.ownPunchDays!.has(d))
  );
  const mutuallyExcluded = candidates.length - contenders.length;

  const scores: TimeAwareScore[] = contenders
    .map((c) => {
      const { paired_days, median_min } = medianAbsDeltaMinutes(
        punchInByDate,
        c.scheduleStartByDate
      );
      return {
        employee_id: c.employee_id,
        overlap_days: paired_days,
        median_clockin_delta_min:
          median_min === null ? null : Math.round(median_min * 10) / 10,
      };
    })
    .filter((s) => s.overlap_days > 0);

  const eligible = scores
    .filter(
      (s) =>
        s.overlap_days >= BEHAVIOURAL_MIN_OVERLAP_DAYS &&
        s.median_clockin_delta_min !== null &&
        s.median_clockin_delta_min <= TIME_CEILING_MIN
    )
    .sort(
      (a, b) =>
        (a.median_clockin_delta_min ?? Infinity) -
        (b.median_clockin_delta_min ?? Infinity)
    );

  const best = eligible[0] ?? null;
  const runnerUp = eligible[1] ?? null;
  const base = {
    best,
    runner_up: runnerUp,
    punch_days: punchInByDate.size,
    candidate_pool_size: candidates.length,
    eligible_count: eligible.length,
    mutually_excluded_count: mutuallyExcluded,
  };
  if (!best) return { decision: "insufficient", ...base };
  // "Within the margin" is inclusive (Codex 2026-08-24): an exact 15.0-min
  // gap is still ambiguity, not a lead.
  if (
    runnerUp &&
    (runnerUp.median_clockin_delta_min ?? Infinity) -
      (best.median_clockin_delta_min ?? Infinity) <=
      TIME_RUNNER_UP_MARGIN_MIN
  ) {
    return { decision: "ambiguous", ...base };
  }
  return { decision: "auto", ...base };
}

/**
 * §5a: which employees are BLOCKED from behavioural candidacy. Only a
 * mapping whose Toast account actually carries punches blocks its owner; a
 * zero-punch mapping (a stale or superseded POS account) leaves the
 * employee eligible — otherwise the true owner is invisible and their
 * punches go to the best remaining wrong candidate (the CPD defect).
 */
export function blockedEmployeeIds(
  crosswalkRows: Array<{ employee_id: string; punch_count: number }>
): Set<string> {
  const out = new Set<string>();
  for (const r of crosswalkRows) {
    if (r.punch_count > 0) out.add(r.employee_id);
  }
  return out;
}

/** Chunk [sinceDate, untilDate] (YYYY-MM-DD, inclusive) into ≤maxDays
 * [startIso, endIso] windows — the probe measured Toast's hard 30-day cap on
 * startDate/endDate, so the backfill is ⌈window/28⌉ requests per store. */
export function chunkWindows(
  sinceDate: string,
  untilDate: string,
  maxDays = 28
): Array<{ startIso: string; endIso: string }> {
  const out: Array<{ startIso: string; endIso: string }> = [];
  const start = new Date(`${sinceDate}T00:00:00Z`);
  const stop = new Date(`${untilDate}T00:00:00Z`);
  if (!(start <= stop)) return out;
  let cursor = start;
  while (cursor <= stop) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);
    const effectiveEnd = chunkEnd <= stop ? chunkEnd : stop;
    out.push({
      startIso: `${cursor.toISOString().slice(0, 10)}T00:00:00.000Z`,
      endIso: `${effectiveEnd.toISOString().slice(0, 10)}T23:59:59.999Z`,
    });
    cursor = new Date(effectiveEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
