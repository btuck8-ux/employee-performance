/**
 * Session secrets for the guest-feedback harvester (handoff §3).
 *
 * Unlike the 7shifts public Access-Token API (client.ts), the Tattle sources
 * (snapshots + reviews) are DASHBOARD-SESSION authenticated: a Bearer token
 * from the dashboard's localStorage `ngStorage-token`, with a companion
 * refresh token. (7Tasks moved to the public 7shifts API 2026-07-27 —
 * tasks-api-source.ts, token auth.)
 *
 * v1 is captured-token-in-env (Playwright auto-login is the v2 durability win).
 * Every reader THROWS when its env is unset — a missing secret must surface as
 * an ingest error, never a fake-empty success (mirrors tokenForCompany()).
 *
 * Tokens expire. When a source sees 401/403 it raises a SessionExpired
 * error (below) whose message tells the operator exactly which vendor to
 * recapture; the harvester logs that as an `error` ingest_run and the nightly
 * alert fires. See docs/runbook-guest-feedback-harvester.md for recapture steps.
 */

/** Tattle merchant id — constant, overridable via env for safety. */
export const TATTLE_MERCHANT_ID = process.env.TATTLE_MERCHANT_ID ?? "2685";

/** Thrown on 401/403 from a vendor session so the operator knows to recapture. */
export class SessionExpiredError extends Error {
  constructor(public vendor: "tattle") {
    super(
      `session expired — recapture ${vendor} (TATTLE_BEARER_TOKEN/TATTLE_REFRESH_TOKEN from dashboard.gettattle.com localStorage); see docs/runbook-guest-feedback-harvester.md`
    );
    this.name = "SessionExpiredError";
  }
}

function required(envName: string): string {
  const v = process.env[envName];
  if (!v) {
    throw new Error(`${envName} is not set (guest-feedback harvester secret).`);
  }
  return v;
}

/** Tattle dashboard bearer (Source A snapshots + Source B reviews). */
export function tattleBearerToken(): string {
  return required("TATTLE_BEARER_TOKEN");
}
