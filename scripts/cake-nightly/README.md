# CAKE nightly timesheet harvester (NOLA)

Automates what was done by hand on 2026-06-19: log into the CAKE staff portal,
pull NOLA's recent timesheets, and land them in EPD `time_entries`.

CAKE has no export and uses a **confidential Keycloak OIDC client** (so there's
no usable API token), so this drives the real browser login with **Playwright**,
then replays the portal's internal `getShifts` call from the authenticated
session and hands the result to EPD's existing
`/api/admin/cake-timesheet-import` route (idempotent upsert + recompute).

## How it runs

`.github/workflows/cake-nightly.yml` runs it every morning (13:30 UTC ≈ 08:30
Chicago) and on manual `workflow_dispatch`. It pulls a **rolling 3-day window**
(so late clock-outs / edits get re-captured) ending yesterday; the upsert keys
on `(employee_id, entry_date, entry_type)`, so re-running adds zero rows.

Flow: GET `/api/admin/cake-profile-ids` (NOLA profile ids from the crosswalk) →
Playwright login → `getShifts` per profile → build CSV → POST to
`/api/admin/cake-timesheet-import`.

## Required GitHub repo secrets

Set these in **Settings → Secrets and variables → Actions**:

| Secret              | Value                                                              |
| ------------------- | ------------------------------------------------------------------ |
| `CAKE_USERNAME`     | CAKE login email (e.g. `tbascom@loveandsandwiches.com`)            |
| `CAKE_PASSWORD`     | CAKE login password                                                |
| `EPD_BASE_URL`      | `https://employee-performance-one.vercel.app`                      |
| `EPD_HARVEST_TOKEN` | a token you choose; must equal Vercel env `CAKE_HARVEST_TOKEN`      |

**Dedicated token (not `CRON_SECRET`).** The import routes accept
`CAKE_HARVEST_TOKEN` (set in **Vercel** env) and fall back to `CRON_SECRET` only
until it's set. So you set a fresh value in Vercel as `CAKE_HARVEST_TOKEN` and the
*same* value in GitHub as `EPD_HARVEST_TOKEN` — EPD's master `CRON_SECRET` is
never shared with the GitHub Action. No CAKE credentials live in the repo or in
EPD; the harvester never logs the password or token.

## Run it locally (to test / watch the login)

```bash
cd scripts/cake-nightly
npm install
npx playwright install chromium
CAKE_USERNAME='tbascom@loveandsandwiches.com' \
CAKE_PASSWORD='********' \
EPD_BASE_URL='https://employee-performance-one.vercel.app' \
EPD_HARVEST_TOKEN='********' \
HEADLESS=false DAYS_BACK=4 \
npm run harvest
```

`HEADLESS=false` opens a visible browser so you can watch the login. On any
failure the script writes `cake-harvest-failure.png` (uploaded as a workflow
artifact in CI) to help debug selector/login drift.

## Notes & maintenance

- **New CAKE hires:** add them to `cake_profile_crosswalk` (the harvester reads
  its profile-id list from there). Any unmapped profile id pulled is reported in
  the import response, never silently dropped.
- **Login selectors:** the Keycloak default theme uses `#username` / `#password`
  / `#kc-login`. If CAKE restyles the login page, update the selectors in
  `harvest.mjs` `login()`; the failure screenshot will show what changed.
- **Risk:** automating a portal login with a stored password can run afoul of
  CAKE's terms and risks bot-detection lockouts. The durable fix remains the
  CAKE Labor-API (a real server-to-server feed) if/when CAKE responds.
