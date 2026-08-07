# Tattle nightly token refresher

Playwright harness (GitHub Actions) that logs into the Tattle dashboard
(`dashboard.gettattle.com`) fresh each run, reads the OIDC access token out of
the authenticated session's storage (`oidc.user:*` localStorage key), and
POSTs it to EPD's `POST /api/admin/set-tattle-token`. The guest-feedback
harvester (Tattle + Reviews) reads the stored token first and only falls back
to the hand-pasted `TATTLE_BEARER_TOKEN` env var — so token refresh stops
being a manual chore. Mirrors `scripts/cake-nightly/`.

Why a browser harness: Tattle auth is OIDC (oidc-client-ts) with rotating
refresh tokens and a form-encoded token endpoint — a server-side env-stored
refresh token goes stale after first use, which is exactly how the old
`TATTLE_REFRESH_URL` path silently failed (removed 2026-07-27).

## Secrets (GitHub repo settings → Actions secrets)

- `TATTLE_USERNAME` / `TATTLE_PASSWORD` — dashboard login.
  ⚠ The account must be MFA-free (use an MFA-exempt service account).
- `EPD_BASE_URL` — `https://employee-performance-one.vercel.app`
- `EPD_HARVEST_TOKEN` — matches Vercel `TASKS_HARVEST_TOKEN`/`CAKE_HARVEST_TOKEN`.

## Local run

```sh
cd scripts/tattle-nightly
npm install && npx playwright install chromium
TATTLE_USERNAME=… TATTLE_PASSWORD=… \
EPD_BASE_URL=… EPD_HARVEST_TOKEN=… HEADLESS=false npm run harvest
```

## Verify

After a run: the route response logs the token's `exp`; then
`select source, status, max(started_at) from ingest_runs where source in
('tattle','reviews') group by 1,2;` should show recent `success` after the
next 09:30 UTC harvest cron without anyone pasting a token.
