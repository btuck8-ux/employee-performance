-- ============================================================================
-- 030_seven_shifts_ingest.sql — Phase 11 nightly auto-ingest (7shifts trio)
-- ============================================================================
-- Adds the 7shifts crosswalk + identity columns and the ingest_runs audit log
-- that backs the nightly /api/cron/nightly-ingest fan-out (time punches,
-- 7tasks summary, POS receipts) across all 8 locations.
--
-- Crosswalk is LOCKED per epd-phase11-EXECUTE-2026-06-06.md /
-- handoff-phase-11-nightly-ingest-2026-06-05.md (orchestrator-authored). The
-- 7shifts location_id sidesteps locations.csv_aliases strict-equality matching
-- entirely for API rows — API rows resolve location by this numeric id, never
-- by string label.
--
-- Token routing (set in Vercel env, not here): company 360494 + 185592 -> token
-- A (IKES_CULTUREPULSE); company 62064 -> token B (IKES_CULTUREPULSE_HOUSTON).
--
-- Additive only. Safe to apply on prod (uyjlnciqecfcxsooupaa).
-- APPLIED TO PROD via Supabase MCP on 2026-06-06; committed for parity (same
-- pattern as migration 027).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1-3. locations: 7shifts crosswalk + per-location POS-via-7shifts flag
-- ---------------------------------------------------------------------------
alter table public.locations
  add column if not exists seven_shifts_company_id  bigint,
  add column if not exists seven_shifts_location_id bigint,
  add column if not exists pos_via_7shifts          boolean not null default false;

-- 7shifts location id is globally unique across companies; enforce when set.
create unique index if not exists locations_seven_shifts_location_id_key
  on public.locations (seven_shifts_location_id)
  where seven_shifts_location_id is not null;

-- ---------------------------------------------------------------------------
-- 4. employees: 7shifts user id (the per-person identity bridge)
-- ---------------------------------------------------------------------------
-- Backfilled by scripts/backfill-seven-shifts-user-id.ts via GET /users email
-- match per company. The 7shifts user is per-person; employees rows are
-- per-location, so the SAME user_id can legitimately appear on several employee
-- rows (shared email across locations). Ingest joins on
-- (seven_shifts_user_id + location_id) to pick the right row — therefore the
-- uniqueness is on (location_id, seven_shifts_user_id), NOT on user_id alone.
alter table public.employees
  add column if not exists seven_shifts_user_id bigint;

create unique index if not exists employees_location_seven_shifts_user_id_key
  on public.employees (location_id, seven_shifts_user_id)
  where seven_shifts_user_id is not null;

-- ---------------------------------------------------------------------------
-- 5. ingest_runs: one row per source x location run, success OR fail
-- ---------------------------------------------------------------------------
-- A zero-result pull is a LOGGED anomaly (status 'empty'), never a silent
-- no-op — the known silent-failure gap gets worse unattended (Sysco-project
-- pattern). `detail` jsonb carries per-run specifics: unmatched 7shifts users,
-- unmatched EPD employees, task-summary rollups, error context. Never dropped.
create table if not exists public.ingest_runs (
  id              uuid primary key default uuid_generate_v4(),
  source          text not null check (source in ('7shifts_time', '7tasks', 'pos_receipts')),
  location_id     uuid references public.locations(id) on delete set null,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null check (status in ('running', 'success', 'empty', 'error')),
  window_start    timestamptz,
  window_end      timestamptz,
  rows_in         int not null default 0,
  rows_upserted   int not null default 0,
  rows_skipped    int not null default 0,
  detail          jsonb,
  error_text      text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_ingest_runs_source_started
  on public.ingest_runs (source, started_at desc);
create index if not exists idx_ingest_runs_location
  on public.ingest_runs (location_id, started_at desc);

alter table public.ingest_runs enable row level security;
create policy "ingest_runs_authenticated_read"
  on public.ingest_runs for select to authenticated
  using (auth.uid() is not null);
-- Writes happen only through the service-role cron client (bypasses RLS); no
-- write policy for authenticated users is intentional.

-- ---------------------------------------------------------------------------
-- Seed the LOCKED 8-row crosswalk, keyed by the existing location_code
-- (migration 027). VERBATIM from the handoff packet:
--   location_code | company_id | location_id
--   NOLA  | 360494 | 438450
--   CPD   | 185592 | 236190
--   HRANCH| 185592 | 305582
--   DTD   | 185592 | 371989
--   FCOL  | 185592 | 463963
--   LONGM | 185592 | 479796
--   COS   | 185592 | 488681
--   HOU   |  62064 |  74873   (Toast-connected -> pos_via_7shifts = true)
-- ---------------------------------------------------------------------------
update public.locations as loc
set seven_shifts_company_id  = v.company_id,
    seven_shifts_location_id = v.location_id,
    pos_via_7shifts          = v.pos_via_7shifts
from (values
  ('NOLA',   360494::bigint, 438450::bigint, false),
  ('CPD',    185592::bigint, 236190::bigint, false),
  ('HRANCH', 185592::bigint, 305582::bigint, false),
  ('DTD',    185592::bigint, 371989::bigint, false),
  ('FCOL',   185592::bigint, 463963::bigint, false),
  ('LONGM',  185592::bigint, 479796::bigint, false),
  ('COS',    185592::bigint, 488681::bigint, false),
  ('HOU',     62064::bigint,  74873::bigint, true)
) as v(location_code, company_id, location_id, pos_via_7shifts)
where loc.location_code = v.location_code;
