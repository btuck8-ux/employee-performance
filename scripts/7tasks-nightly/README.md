# 7Tasks nightly harvester

Playwright harness (GitHub Actions) that logs into app.7shifts.com fresh each
run, exports the per-employee Tasks report for each company (62064 Houston,
185592 the 6 Colorado stores; NOLA has no 7Tasks module), and POSTs each CSV
to EPD's `POST /api/admin/import-tasks-csv`. Mirrors `scripts/cake-nightly/`.

Why a browser harness: the per-employee Tasks report only exists on the
dashboard session API (`app.7shifts.com/api/v2`, not the public Access-Token
API), and dashboard cookies expire in days — the same fragility that retired
the server-side pull (see the harvest-guest-feedback cron route comment).

## Secrets (GitHub repo settings → Actions secrets)

- `SEVENSHIFTS_USERNAME` / `SEVENSHIFTS_PASSWORD` — dashboard login.
  ⚠ The account must be MFA-free (use an MFA-exempt service account).
- `EPD_BASE_URL` — `https://employee-performance-one.vercel.app`
- `EPD_HARVEST_TOKEN` — matches Vercel `TASKS_HARVEST_TOKEN` (or the shared
  `CAKE_HARVEST_TOKEN`; the route accepts either, `CRON_SECRET` as fallback).

## Local run

```sh
cd scripts/7tasks-nightly
npm install && npx playwright install chromium
SEVENSHIFTS_USERNAME=… SEVENSHIFTS_PASSWORD=… \
EPD_BASE_URL=… EPD_HARVEST_TOKEN=… \
DAYS_BACK=7 HEADLESS=false npm run harvest
```

## Backfill

Set `DAYS_BACK` wide (e.g. `77` to reach back to 2026-05-11) for a one-time
catch-up; the import is idempotent so overlap is free.
