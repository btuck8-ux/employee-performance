-- ============================================================================
-- 031_cake_profile_crosswalk.sql — CAKE → EPD identity crosswalk (NOLA actuals)
-- ============================================================================
-- Maps a CAKE labor `profileId` to an EPD employee. NOLA's POS is CAKE (not
-- 7shifts-integrated), so its worked actuals arrive tagged with CAKE profile
-- ids; this table resolves profileId -> employee for the time_entries upsert.
-- Two CAKE profiles can collapse to one employee (duplicate CAKE profiles for
-- the same person) — hence profileId is the PK and employee_id is non-unique.
--
-- APPLIED TO PROD via Supabase MCP on 2026-06-08 (version 20260608214848)
-- during the NOLA CAKE backfill (decisions-log-cake-ingest-2026-06-08.md);
-- committed here for repo<->prod parity, same pattern as migrations 027/030.
--
-- NOTE (parity, not a change): this table is reproduced exactly as it exists in
-- prod, where RLS is NOT enabled (unlike ingest_runs in migration 030). Reads go
-- through the service-role cron client only. Enabling RLS + an authenticated
-- read policy here is a reasonable hardening follow-up, but is intentionally left
-- out of this parity file so the file matches the live schema 1:1.
--
-- Additive only. Safe to (re-)apply on prod (uyjlnciqecfcxsooupaa).
-- ============================================================================

create table if not exists public.cake_profile_crosswalk (
  cake_profile_id bigint primary key,
  employee_id     uuid not null references public.employees(id) on delete cascade,
  employee_code   text not null,
  location_id     uuid not null references public.locations(id),
  full_name       text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_cake_profile_crosswalk_employee
  on public.cake_profile_crosswalk (employee_id);
