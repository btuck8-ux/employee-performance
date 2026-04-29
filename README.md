# Employee Performance Platform

Internal Next.js + Supabase app for ingesting employee performance data and generating quarterly per-employee PDF reports.

## Stack

- Next.js (App Router) on Vercel, TypeScript, Tailwind CSS
- Supabase (Postgres, Auth, Storage)
- `@react-pdf/renderer` for PDFs
- `papaparse` + `sheetjs (xlsx)` for ingest

## Local development

```bash
npm install
cp .env.example .env.local   # fill in keys
npm run dev
```

Open http://localhost:3000 — you'll be redirected to `/auth/login` and then through Google OAuth.

## Environment variables

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (public, safe in client) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (secret, server only) |
| `NEXT_PUBLIC_SITE_URL` | Site URL used for OAuth redirect (`http://localhost:3000` in dev) |

## Database

Schema migrations live in `supabase/migrations/`. They've been applied directly to the live Supabase project; these files are the canonical source of truth and reference for future re-creation.

## Build phases

- ✅ **Phase 1** — Foundation: schema, RLS, auth, dashboard shell, clients / locations / employees CRUD.
- ⬜ **Phase 2** — Data ingest: tolerant CSV / XLSX upload, alias map, fuzzy matching.
- ⬜ **Phase 3** — Performance dashboard: location detail with quarter selector and employee table; stale-data flagging.
- ⬜ **Phase 4** — Report generation: `@react-pdf/renderer` template, quarterly and custom-range modes, archive UI.
- ⬜ **Phase 5** — Automation: Vercel cron for stale-data check and auto-generate-latest-reports.

See `../PROJECT_BRIEF_v3.md` (titled v4 internally) for the full spec.
