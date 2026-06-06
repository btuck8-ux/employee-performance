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
 * Zones are keyed by `location_code` (migration 027). All Colorado stores are
 * America/Denver; NOLA and Houston are America/Chicago.
 */

export const LOCATION_TIMEZONES: Record<string, string> = {
  NOLA: "America/Chicago",
  HOU: "America/Chicago",
  CPD: "America/Denver",
  COS: "America/Denver",
  DTD: "America/Denver",
  FCOL: "America/Denver",
  HRANCH: "America/Denver",
  LONGM: "America/Denver",
};

export function timezoneForLocationCode(locationCode: string): string {
  const tz = LOCATION_TIMEZONES[locationCode];
  if (!tz) {
    // Default to Denver rather than throwing — a missing entry shouldn't halt
    // ingest, but it's a config bug worth a loud log.
    console.warn(
      `[ingest/tz] no timezone mapped for location_code "${locationCode}"; defaulting to America/Denver`
    );
    return "America/Denver";
  }
  return tz;
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
