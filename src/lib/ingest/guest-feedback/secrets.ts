/**
 * Session secrets for the guest-feedback harvester (handoff §3).
 *
 * Unlike the 7shifts public Access-Token API (client.ts), the three captured
 * sources are DASHBOARD-SESSION authenticated:
 *   - Tattle (snapshots + reviews): a Bearer token from the dashboard's
 *     localStorage `ngStorage-token`, with a companion refresh token.
 *   - 7shifts dashboard (per-employee Tasks export): an HttpOnly cookie session.
 *
 * v1 is captured-token-in-env (Playwright auto-login is the v2 durability win).
 * Every reader THROWS when its env is unset — a missing secret must surface as
 * an ingest error, never a fake-empty success (mirrors tokenForCompany()).
 *
 * Tokens/cookies expire. When a source sees 401/403 it raises a SessionExpired
 * error (below) whose message tells the operator exactly which vendor to
 * recapture; the harvester logs that as an `error` ingest_run and the nightly
 * alert fires. See docs/runbook-guest-feedback-harvester.md for recapture steps.
 */

/** Tattle merchant id — constant, overridable via env for safety. */
export const TATTLE_MERCHANT_ID = process.env.TATTLE_MERCHANT_ID ?? "2685";

/** Thrown on 401/403 from a vendor session so the operator knows to recapture. */
export class SessionExpiredError extends Error {
  constructor(public vendor: "tattle" | "7shifts") {
    super(
      `session expired — recapture ${vendor} (${
        vendor === "tattle"
          ? "TATTLE_BEARER_TOKEN/TATTLE_REFRESH_TOKEN from dashboard.gettattle.com localStorage"
          : "SEVENSHIFTS_DASHBOARD_COOKIE from an authenticated app.7shifts.com session"
      }); see docs/runbook-guest-feedback-harvester.md`
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

/** Tattle refresh token — optional; used to refresh the bearer on expiry. */
export function tattleRefreshToken(): string | null {
  return process.env.TATTLE_REFRESH_TOKEN ?? null;
}

/** 7shifts dashboard cookie session (Source C per-employee Tasks export). */
export function sevenShiftsDashboardCookie(): string {
  return required("SEVENSHIFTS_DASHBOARD_COOKIE");
}
