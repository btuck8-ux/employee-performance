/**
 * Thin 7shifts REST client for the nightly EPD ingest.
 *
 * API facts locked 6/5 (handoff-phase-11-nightly-ingest-2026-06-05.md):
 *  - Base https://api.7shifts.com, company_id in path.
 *  - Header `x-api-version: 2025-03-01`.
 *  - Bearer = long-lived Access Token. 10 req/s/token. Cursor pagination
 *    (`meta.cursor.next`).
 *  - Token routing by company_id:
 *      A (IKES_CULTUREPULSE)         -> company 360494 (NOLA) + 185592 (6 CO)
 *      B (IKES_CULTUREPULSE_HOUSTON) -> company 62064  (Houston)
 *
 * EPD pulls ACTUALS ONLY. No shifts/scheduled endpoints (that's Culture
 * Pulse's domain — hard fence).
 */

export const SEVEN_SHIFTS_BASE = "https://api.7shifts.com";
export const SEVEN_SHIFTS_API_VERSION = "2025-03-01";

/** Companies served by token A vs token B. */
const TOKEN_A_COMPANIES = new Set<number>([360494, 185592]);
const TOKEN_B_COMPANIES = new Set<number>([62064]);

/**
 * Resolve the access token for a 7shifts company_id from env. Throws (rather
 * than silently no-op) so a misconfigured env surfaces as an ingest error, not
 * an empty pull masquerading as success.
 */
export function tokenForCompany(companyId: number): string {
  let envName: string | null = null;
  if (TOKEN_A_COMPANIES.has(companyId)) envName = "IKES_CULTUREPULSE";
  else if (TOKEN_B_COMPANIES.has(companyId)) envName = "IKES_CULTUREPULSE_HOUSTON";

  if (!envName) {
    throw new Error(
      `No 7shifts token route for company_id ${companyId} (expected one of 360494, 185592, 62064).`
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
