/**
 * Thin 7shifts REST client for the nightly EPD ingest.
 *
 * API facts locked 6/5 (handoff-phase-11-nightly-ingest-2026-06-05.md):
 *  - Base https://api.7shifts.com, company_id in path.
 *  - Header `x-api-version: 2025-03-01`.
 *  - Bearer = long-lived Access Token. 10 req/s/token. Cursor pagination
 *    (`meta.cursor.next`).
 *  - Token routing by company_id (three separate tokens — NOLA and Colorado
 *    were split off what used to be one shared token):
 *      IKES_CULTUREPULSE_HOUSTON  -> company 62064  (Houston)
 *      IKES_CULTUREPULSE          -> company 360494 (NOLA)
 *      IKES_COLORADO_CULTUREPULSE -> company 185592 (the 6 Colorado stores)
 *
 * SCOPE (rewritten 2026-08-23 — Tucker's ruling, multi-location sprint §4-H):
 * EPD pulls actuals AND scheduled shifts (`/shifts`) directly. The old
 * "actuals only, no shifts endpoints" fence came from the 2026-06-01
 * scheduling pivot, whose premise — "EPD scores off actuals, so it loses
 * nothing by not owning schedules" — proved false: the attendance metric's
 * denominator IS the schedule, and the CP-sourced copy could not be cleaned
 * upstream (no deleted/draft signal in `weekly_schedule_entries`; deleted
 * shifts vanish from the 7shifts payload and CP never prunes). This is EPD
 * owning its own metric inputs, NOT scheduling-as-a-product — the pivot
 * still stands for the product question, and migration 028 stays shelved.
 * Do not "fix" the shifts pull as a fence violation.
 */

export const SEVEN_SHIFTS_BASE = "https://api.7shifts.com";
export const SEVEN_SHIFTS_API_VERSION = "2025-03-01";

/**
 * 7shifts access-token env var per company_id. Three distinct tokens: Houston,
 * NOLA, and Colorado were each issued separately (NOLA and the 6 Colorado stores
 * were split off what was once a single shared token). 185592 routing here is
 * load-bearing for the CO stores — it must NOT fall back to the NOLA token.
 */
const TOKEN_ENV_BY_COMPANY: Record<number, string> = {
  62064: "IKES_CULTUREPULSE_HOUSTON", // Houston
  360494: "IKES_CULTUREPULSE", // NOLA
  185592: "IKES_COLORADO_CULTUREPULSE", // the 6 Colorado stores
};

/**
 * Resolve the access token for a 7shifts company_id from env. Throws (rather
 * than silently no-op) so a misconfigured env surfaces as an ingest error, not
 * an empty pull masquerading as success.
 */
export function tokenForCompany(companyId: number): string {
  const envName = TOKEN_ENV_BY_COMPANY[companyId];
  if (!envName) {
    throw new Error(
      `No 7shifts token route for company_id ${companyId} (expected one of 62064, 360494, 185592).`
    );
  }
  const token = process.env[envName];
  if (!token) {
    throw new Error(`7shifts token env ${envName} is not set.`);
  }
  return token;
}

interface CursorMeta {
  cursor?: {
    current?: string | null;
    prev?: string | null;
    next?: string | null;
    count?: number | null;
  };
}

interface ListResponse<T> {
  object?: string;
  data: T[];
  meta?: CursorMeta;
}

interface SingleResponse<T> {
  object?: string;
  data: T;
}

export type QueryParams = Record<
  string,
  string | number | boolean | null | undefined
>;

/** Small spacer between paged requests; keeps us comfortably under 10 req/s. */
const PAGE_DELAY_MS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(
  companyId: number,
  path: string,
  params: QueryParams = {}
): string {
  const url = new URL(`${SEVEN_SHIFTS_BASE}/v2/company/${companyId}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function request<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-api-version": SEVEN_SHIFTS_API_VERSION,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `7shifts ${res.status} ${res.statusText} for ${stripQuery(url)}: ${body.slice(0, 500)}`
    );
  }
  return (await res.json()) as T;
}

/** Drop the query string for safe logging (never leak tokens or filters). */
function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}

/**
 * Fetch every page of a cursor-paginated list endpoint and return the flat
 * array. Bounded by `maxPages` as a runaway guard.
 */
export async function getAll<T>(
  companyId: number,
  path: string,
  params: QueryParams = {},
  maxPages = 100
): Promise<T[]> {
  const token = tokenForCompany(companyId);
  const out: T[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const url = buildUrl(companyId, path, { ...params, cursor });
    const body = await request<ListResponse<T>>(url, token);
    if (Array.isArray(body.data)) out.push(...body.data);
    cursor = body.meta?.cursor?.next ?? undefined;
    pages += 1;
    if (cursor) await sleep(PAGE_DELAY_MS);
  } while (cursor && pages < maxPages);

  return out;
}

/** Fetch a single-object endpoint (e.g. task_list_daily_summary). */
export async function getOne<T>(
  companyId: number,
  path: string,
  params: QueryParams = {}
): Promise<T> {
  const token = tokenForCompany(companyId);
  const url = buildUrl(companyId, path, params);
  const body = await request<SingleResponse<T>>(url, token);
  return body.data;
}
