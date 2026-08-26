/**
 * UTC -> store-local wall-clock conversion.
 *
 * Why this matters: `time_entries.in_time`/`out_time` and
 * `sales_records.transaction_at` are stored as the store's LOCAL clock-of-day
 * (the POS tip-attribution math in migration 016 overlaps the two on the same
 * TZ-free local clock). But 7shifts returns every timestamp in UTC ISO8601.
 * So every punch/receipt timestamp must be projected into the store's local
 * zone before it lands.
 *
 * The zone comes from `locations.timezone` — the table OWNS this fact
 * (Tucker 2026-08-26: DO NOT KEEP A COPY OF ANYTHING THE DATABASE OWNS).
 * The hand-maintained map that used to live here was a live latent bug: its
 * fallback silently defaulted to the Denver zone with only a warn line, so
 * FCCSU's 228 shift rows and 150 punches carried correct local times BY
 * COINCIDENCE of being a Denver store. A Houston- or NOLA-shaped store
 * seeded the same way would have written every timestamp an hour wrong.
 *
 * storeTimezone() therefore takes the location ROW (whose `timezone` column
 * every loader now selects) and THROWS when the zone is missing — a
 * fallback that is right by accident is indistinguishable from one that is
 * right by design until the day it isn't. Halting one store's ingest run is
 * the correct cost: its error lands in ingest_runs + the fatal alert, while
 * a guessed zone lands wrong wall-clocks nobody can distinguish from data.
 */

export function storeTimezone(loc: {
  location_code: string;
  timezone: string | null | undefined;
}): string {
  if (!loc.timezone) {
    throw new Error(
      `[ingest/tz] locations.timezone is unset for "${loc.location_code}" — ` +
        "refusing to guess a zone (a defaulted timezone writes local " +
        "wall-clocks silently wrong). Set locations.timezone for this store."
    );
  }
  return loc.timezone;
}

export interface LocalWallClock {
  /** YYYY-MM-DD in the store's local zone. */
  date: string;
  /** HH:MM:SS (24h) in the store's local zone. */
  time: string;
  /** "YYYY-MM-DDTHH:MM:SS" — local, no TZ suffix (matches sales_records). */
  timestamp: string;
}

// Reuse one formatter per zone; constructing Intl.DateTimeFormat is not free.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/**
 * Project a UTC ISO8601 instant into a store-local wall-clock. Returns null for
 * null/empty/unparseable input (a null clock-out is normal for an open punch).
 */
export function utcToLocalWallClock(
  utcIso: string | null | undefined,
  timeZone: string
): LocalWallClock | null {
  if (!utcIso) return null;
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return null;

  const parts = formatterFor(timeZone).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  if (!year || !month || !day) return null;

  const date = `${year}-${month}-${day}`;
  const time = `${hour}:${minute}:${second}`;
  return { date, time, timestamp: `${date}T${time}` };
}
