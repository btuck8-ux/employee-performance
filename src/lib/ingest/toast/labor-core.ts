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
export const BEHAVIOURAL_MIN_OVERLAP_DAYS = 6;
/** The best candidate must lead the runner-up by at least this many
 * overlapping days, or the match is ambiguous and queues for SA review
 * (ruling §4 guard 2 — identical schedules are a known real shape). */
export const BEHAVIOURAL_RUNNER_UP_MARGIN = 3;

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

export interface BehaviouralCandidate {
  employee_id: string;
  scheduledDates: Set<string>;
}

export interface BehaviouralScore {
  employee_id: string;
  overlap_days: number;
}

export interface BehaviouralVerdict {
  decision: "auto" | "ambiguous" | "insufficient";
  best: BehaviouralScore | null;
  runner_up: BehaviouralScore | null;
  punch_days: number;
}

/**
 * Score one unmatched Toast guid's punch dates against candidate employees'
 * scheduled dates (ruling §4 path 2). Auto only when the best candidate
 * clears BEHAVIOURAL_MIN_OVERLAP_DAYS AND leads any runner-up by at least
 * BEHAVIOURAL_RUNNER_UP_MARGIN. Candidates are the CALLER's responsibility
 * to restrict to the same store and to employees without an existing
 * crosswalk row (a recreated Toast account for an already-mapped person
 * queues for SA instead of guessing).
 */
export function scoreBehaviouralMatch(
  punchDates: Set<string>,
  candidates: BehaviouralCandidate[]
): BehaviouralVerdict {
  const scores: BehaviouralScore[] = candidates
    .map((c) => {
      let overlap = 0;
      for (const d of punchDates) if (c.scheduledDates.has(d)) overlap += 1;
      return { employee_id: c.employee_id, overlap_days: overlap };
    })
    .filter((s) => s.overlap_days > 0)
    .sort((a, b) => b.overlap_days - a.overlap_days);

  const best = scores[0] ?? null;
  const runnerUp = scores[1] ?? null;
  const base = { best, runner_up: runnerUp, punch_days: punchDates.size };
  if (!best || best.overlap_days < BEHAVIOURAL_MIN_OVERLAP_DAYS) {
    return { decision: "insufficient", ...base };
  }
  if (runnerUp && best.overlap_days - runnerUp.overlap_days < BEHAVIOURAL_RUNNER_UP_MARGIN) {
    return { decision: "ambiguous", ...base };
  }
  return { decision: "auto", ...base };
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
