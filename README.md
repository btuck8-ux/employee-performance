# Employee Performance Platform

Internal Next.js + Supabase app for ingesting employee performance data and generating quarterly per-employee PDF reports.

Before writing code in this repo, read **[AGENTS.md](./AGENTS.md)** — the trap-list of live consumers, scoring lockstep rules, and deliberate keeps.

## Stack

- Next.js (App Router) on Vercel, TypeScript, Tailwind CSS
- Supabase (Postgres, Auth, Storage)
- `@react-pdf/renderer` for PDFs
- `papaparse` for CSV ingest

## Local development

```bash
npm install
cp .env.example .env.local   # fill in keys
npm run dev
```

Open http://localhost:3000 — you'll be redirected to `/auth/login` and then through Google OAuth.

## Environment variables

See [.env.example](./.env.example) for the full roster (~21 vars: Supabase, cron/feed tokens, Tattle session, 7shifts `IKES_*` tokens, Toast, CulturePulse bridge, Resend alerts). Two operational notes:

- `IKES_COLORADO_CULTUREPULSE` must exist in prod or Colorado ingest breaks at the next nightly.
- 7shifts tokens are **Sensitive** (write-only) Vercel vars — identity/backfill work runs in-cron, never via local scripts.

## App surface

- `/dashboard` — overview shell
- `/dashboard/clients`, `/dashboard/locations`, `/dashboard/employees` — CRUD + per-entity detail
- `/dashboard/locations/[id]` — location detail: quarter selector, employee performance table, manual upload cards
- `/dashboard/locations/[id]/rankings` + `/teams` — rankings and team views
- `/dashboard/uploads` — bulk upload surface
- `/dashboard/reports` — PDF generation + archive (`/api/reports/[id]` serves them)
- `/dashboard/admin/scoring` — scoring administration

## Automated feeds

Vercel crons (`vercel.json`), all UTC:

| Cron | Time | Job |
|---|---|---|
| `sweep-csv-uploads` | 04:00 | sweep stale upload storage |
| `nightly-ingest` | 09:00 | 7shifts fan-out: time punches, identity bridge, POS (HOU) |
| `ingest-toast-sales` | 09:15 | Toast sales feed |
| `harvest-guest-feedback` | 09:30 | Tattle snapshots + reviews + 7Tasks (API) |
| `sync-cp-schedules` | 09:40 | CulturePulse scheduled-shifts sync (attendance/on-time inputs; first run backfills from 2026-06-01) |
| `sync-cp-surveys` | 09:45 | CulturePulse survey sync |
| `ingest-toast-kitchen` | 10:00 | Toast kitchen ticket times |

GitHub Actions (browser harnesses):

| Action | Time (UTC) | Lands on |
|---|---|---|
| `cake-nightly` | 13:30 | `/api/admin/cake-profile-ids`, `/api/admin/cake-timesheet-import` (NOLA labor) |
| `tattle-nightly` | 13:50 | `/api/admin/set-tattle-token` (Tattle token — see note) |

> **tattle-nightly reality check (2026-08-10):** the Action is scheduled but not
> operational — it has run exactly once ever (failed, 2026-07-27) and has never
> stored a token. The Tattle feed rides the env `TATTLE_BEARER_TOKEN` with
> manual recapture (see the guest-feedback runbook); the nightly alert email is
> the tripwire when that token expires. The `/api/admin/set-tattle-token`
> landing point stays live for the Action.

Outbound feeds — polled daily in production by CulturePulse (08:45/09:00 UTC) and Training HQ (11:15 UTC). Shape changes require coordination (see AGENTS.md); the payload is additive-only:

- `/api/identity` — CP 08:45 UTC poll
- `/api/scores` — CP 09:00 UTC, THQ 11:15 UTC; serves the 11 composite fields plus the 9 individual metrics behind CS/TIS (mig 045) and the 6 per-metric count fields (mig 048) — 26 columns total, wire names mirror `performance_records` columns, `null` = not-computed, never 0
- `/api/scores/range` — THQ on-demand (server-side pass-through, 10-min cache TTL); computes the 9 metrics + 6 counts over an arbitrary `start`/`end` window (calendar-valid, ≥ 2026-01-01, ≤ 366 days) via the canonical range engine — no composites in v1, `null` = not-computable-for-window, pagination `page`/`limit` default 25 / max 50, same `SCORES_FEED_TOKEN` bearer. Contract: the 2026-08-14 THQ memo (locked); `range-feed-contract.test.ts` pins the shape

## Database

Schema migrations live in `supabase/migrations/` (head: 048; 015 intentionally absent). They're applied to the live Supabase project as they land; these files are the canonical source of truth and reference for future re-creation.

## Build phases

- ✅ **Phase 1** — Foundation: schema, RLS, auth, dashboard shell, clients / locations / employees CRUD.
- ✅ **Phase 2** — Data ingest: tolerant CSV upload, alias map, fuzzy matching.
- ✅ **Phase 3** — Performance dashboard: location detail with quarter selector and employee table; stale-data flagging.
- ✅ **Phase 4** — Report generation: `@react-pdf/renderer` template, quarterly and custom-range modes, archive UI.
- ✅ **Phase 5** — Automation: Vercel crons + GitHub Actions for the nightly feed family (table above).

The full spec lives in the project workspace (`PROJECT_BRIEF_v3.md`, titled v4 internally) — it is not part of this repo.
