/**
 * Reusable Toast Standard API client for the EPD ingest.
 *
 * API facts locked 7/26 (handoff-co-sales-toast-plus-cake-2026-07-26.md §2.1,
 * verified live against prod the same day):
 *  - Host https://ws-api.toasttab.com (from the provisioned credential).
 *  - Auth: POST /authentication/v1/authentication/login with
 *    { clientId, clientSecret, userAccessType: "TOAST_MACHINE_CLIENT" } ->
 *    token.accessToken (JWT) + token.expiresIn (86400s observed).
 *  - Every data request carries Authorization: Bearer <token> AND
 *    Toast-Restaurant-External-ID: <restaurantGuid> (per-store scoping).
 *  - List endpoints (e.g. /orders/v2/ordersBulk) paginate by page/pageSize;
 *    a short page (< pageSize) signals the end.
 *
 * This is deliberately a GENERIC client, not an orders-only fetcher: the
 * credential carries 14 read scopes on purpose (handoff §2.5) and future
 * domains (labor, config, menus, ...) become sibling fetchers on top of this
 * one auth/token/host layer — additive, never a rewrite. The Orders pull
 * lives in orders.ts.
 */

const TOAST_AUTH_PATH = "/authentication/v1/authentication/login";

/** Small spacer between paged requests; Toast rate-limits per credential. */
const PAGE_DELAY_MS = 150;
/** Retries for 429/5xx before giving up on a request. */
const MAX_RETRIES = 3;

/**
 * Resolve a required Toast env var. Throws (rather than silently no-op) so a
 * missing secret surfaces as an ingest error, not a fake-empty success —
 * same contract as the 7shifts token routing (client.ts there).
 */
function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Toast env ${name} is not set.`);
  return v;
}

export function toastHost(): string {
  // Strip any trailing slash so path joins stay predictable.
  return requiredEnv("TOAST_API_HOST").replace(/\/+$/, "");
}

interface CachedToken {
  accessToken: string;
  /** Epoch ms after which we re-authenticate (expiresIn minus safety margin). */
  refreshAfterMs: number;
}

// Module-level cache: survives across invocations within a warm function
// instance; a cold start just re-authenticates (tokens live 24h).
let cachedToken: CachedToken | null = null;

async function login(): Promise<CachedToken> {
  const res = await fetch(`${toastHost()}${TOAST_AUTH_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: requiredEnv("TOAST_CLIENT_ID"),
      clientSecret: requiredEnv("TOAST_CLIENT_SECRET"),
      userAccessType: "TOAST_MACHINE_CLIENT",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Toast auth ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    token?: { accessToken?: string; expiresIn?: number };
  };
  const accessToken = json.token?.accessToken;
  if (!accessToken) throw new Error("Toast auth response carried no token.accessToken");
  const expiresInMs = (json.token?.expiresIn ?? 3600) * 1000;
  // Refresh 5 minutes early so a token never expires mid-run.
  return { accessToken, refreshAfterMs: Date.now() + expiresInMs - 5 * 60 * 1000 };
}

export async function getAccessToken(): Promise<string> {
  if (!cachedToken || Date.now() >= cachedToken.refreshAfterMs) {
    cachedToken = await login();
  }
  return cachedToken.accessToken;
}

/** Drop a cached token (used on 401 so the retry re-authenticates). */
export function invalidateToken(): void {
  cachedToken = null;
}

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

function buildUrl(path: string, params: QueryParams = {}): string {
  const url = new URL(`${toastHost()}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Drop the query string for safe logging (never leak filters/ids). */
function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The shared request loop: auth handshake, one-shot re-auth on 401 (stale
 * cached token), bounded backoff on 429/5xx (honoring Retry-After when Toast
 * sends one). Returns the terminal Response; callers decide what non-2xx means.
 */
async function toastFetch(restaurantGuid: string, url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Toast-Restaurant-External-ID": restaurantGuid,
        Accept: "application/json",
      },
    });

    if (res.status === 401 && attempt < MAX_RETRIES) {
      invalidateToken();
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * 2 ** attempt;
      await sleep(Math.min(waitMs, 15_000));
      continue;
    }

    return res;
  }
}

/** Authenticated GET against one restaurant; throws on any non-2xx. */
export async function toastGet<T>(
  restaurantGuid: string,
  path: string,
  params: QueryParams = {}
): Promise<T> {
  const url = buildUrl(path, params);
  const res = await toastFetch(restaurantGuid, url);
  if (res.ok) return (await res.json()) as T;

  const body = await res.text().catch(() => "");
  throw new Error(
    `Toast ${res.status} ${res.statusText} for ${stripQuery(url)}: ${body.slice(0, 500)}`
  );
}

/**
 * Status-aware GET: hands back { status, body } instead of throwing on non-2xx.
 * The Kitchen export needs this — its 204 No Content is a meaningful signal
 * ("no RMS Pro+ subscription"), not an error, and must reach the caller.
 */
export async function toastGetWithStatus<T>(
  restaurantGuid: string,
  path: string,
  params: QueryParams = {}
): Promise<{ status: number; body: T | null; error_body?: string }> {
  const url = buildUrl(path, params);
  const res = await toastFetch(restaurantGuid, url);
  if (res.status === 204) return { status: 204, body: null };
  if (res.ok) return { status: res.status, body: (await res.json()) as T };

  const text = await res.text().catch(() => "");
  return { status: res.status, body: null, error_body: text.slice(0, 500) };
}

/**
 * Fetch every page of a page/pageSize-paginated array endpoint and return the
 * flat array. A short page ends the loop; `maxPages` is a runaway guard.
 */
export async function getPagedList<T>(
  restaurantGuid: string,
  path: string,
  params: QueryParams = {},
  { pageSize = 100, maxPages = 100 }: { pageSize?: number; maxPages?: number } = {}
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await toastGet<T[]>(restaurantGuid, path, { ...params, page, pageSize });
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
    await sleep(PAGE_DELAY_MS);
  }
  return out;
}
