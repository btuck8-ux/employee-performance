/**
 * Shared authenticated fetch for the two Tattle sources (snapshots + reviews),
 * which use the same dashboard Bearer token (handoff §3).
 *
 * On 401/403 it attempts ONE token refresh if a refresh route is configured
 * (TATTLE_REFRESH_URL + TATTLE_REFRESH_TOKEN — the standard ngStorage/JWT
 * refresh the handoff flags as the durability win), then retries. If refresh is
 * not configured or fails, it raises SessionExpiredError('tattle') so the
 * harvester logs an `error` ingest_run with a clear "recapture tattle" message
 * and the nightly alert fires. v1 ships captured-token-in-env; wiring
 * TATTLE_REFRESH_URL is the no-recapture upgrade.
 */

import {
  SessionExpiredError,
  tattleBearerToken,
  tattleRefreshToken,
} from "./secrets";

// Module-scoped so a successful refresh within one harvest run is reused by
// later requests in that run. Lazily seeded from env on first use.
let currentBearer: string | null = null;

function bearer(): string {
  if (!currentBearer) currentBearer = tattleBearerToken();
  return currentBearer;
}

/**
 * Best-effort refresh. Returns true if a new bearer was obtained. Only attempts
 * when both TATTLE_REFRESH_URL and a refresh token are present — we do NOT guess
 * the refresh endpoint (handoff: "find the refresh endpoint when wiring").
 */
async function tryRefresh(): Promise<boolean> {
  const refreshUrl = process.env.TATTLE_REFRESH_URL;
  const refreshToken = tattleRefreshToken();
  if (!refreshUrl || !refreshToken) return false;

  try {
    const res = await fetch(refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${refreshToken}`,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as
      | { token?: string; access_token?: string }
      | null;
    const next = body?.token ?? body?.access_token ?? null;
    if (!next) return false;
    currentBearer = next;
    return true;
  } catch {
    return false;
  }
}

interface TattleFetchInit {
  method?: "GET" | "POST";
  body?: unknown;
  /** Accept header; snapshots return JSON, the review export returns JSON too. */
  accept?: string;
}

/**
 * Fetch a Tattle dashboard URL with the bearer, refreshing once on 401/403.
 * Returns the raw Response (callers parse JSON or follow download links). On a
 * non-auth error it throws with the status + a truncated body for logs.
 */
export async function tattleFetch(
  url: string,
  init: TattleFetchInit = {}
): Promise<Response> {
  const doFetch = (token: string) =>
    fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: init.accept ?? "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

  let res = await doFetch(bearer());

  if (res.status === 401 || res.status === 403) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await doFetch(bearer());
    }
    if (res.status === 401 || res.status === 403) {
      throw new SessionExpiredError("tattle");
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Tattle ${res.status} ${res.statusText} for ${stripQuery(url)}: ${body.slice(0, 400)}`
    );
  }
  return res;
}

/** Drop the query string for safe logging (never leak tokens or filters). */
export function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}
