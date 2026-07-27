/**
 * Shared authenticated fetch for the two Tattle sources (snapshots + reviews),
 * which use the same dashboard Bearer token (handoff §3; durable-auth rework
 * 2026-07-27 Part 3).
 *
 * Token resolution: the DB-stored token pushed nightly by the Playwright
 * harness (app_settings via token-store.ts) wins; the hand-pasted
 * TATTLE_BEARER_TOKEN env var is the bootstrap/fallback. On 401/403 the store
 * is RE-READ once (the harness may have pushed a fresher token than the one
 * cached this run) and the request retried; still-unauthorized raises
 * SessionExpiredError('tattle') so the run logs an `error` ingest_run and the
 * nightly alert fires.
 *
 * The old TATTLE_REFRESH_URL JSON refresh was removed: live inspection
 * (2026-07-27) showed Tattle auth is OIDC (oidc-client-ts) — a form-encoded
 * grant_type=refresh_token POST with a client_id, not a JSON {refresh_token}
 * body — and OIDC refresh tokens rotate, so a server-side env refresh goes
 * stale anyway. The Playwright harness IS the refresh path (same family as
 * CAKE + 7Tasks).
 */

import { SessionExpiredError, tattleBearerToken } from "./secrets";
import { readStoredTattleBearer } from "./token-store";

// Module-scoped so the store lookup happens once per warm run; a 401 re-read
// updates it in place.
let currentBearer: string | null = null;

async function bearer(): Promise<string> {
  if (!currentBearer) {
    currentBearer = (await readStoredTattleBearer()) ?? tattleBearerToken();
  }
  return currentBearer;
}

/**
 * On 401/403: re-read the stored token, bypassing the run cache. Returns true
 * only when the store holds a DIFFERENT token than the one that just failed.
 */
async function tryStoredRefresh(failedToken: string): Promise<boolean> {
  const stored = await readStoredTattleBearer();
  if (!stored || stored === failedToken) return false;
  currentBearer = stored;
  return true;
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

  const usedToken = await bearer();
  let res = await doFetch(usedToken);

  if (res.status === 401 || res.status === 403) {
    const refreshed = await tryStoredRefresh(usedToken);
    if (refreshed) {
      res = await doFetch(await bearer());
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
