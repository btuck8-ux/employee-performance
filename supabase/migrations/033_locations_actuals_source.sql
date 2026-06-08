-- ============================================================================
-- 033_locations_actuals_source.sql — route a location's worked actuals source
-- ============================================================================
-- The nightly orchestrator fans 7shifts_time out to EVERY crosswalk location.
-- NOLA's POS is CAKE, not 7shifts-integrated, so its nightly 7shifts_time run
-- is a silent no-op that logs `empty` every night (and would double-source if
-- the CAKE feed also wrote time_entries). This column tells the orchestrator
-- which feed owns a location's actuals:
--
--   '7shifts' (default) -> worked time_entries come from the 7shifts time pull
--   'cake'              -> worked time_entries come from the CAKE labor feed
--
-- The orchestrator skips the 7shifts_time block when actuals_source <> '7shifts'.
-- Scheduling (weekly_schedule_entries) is unaffected — NOLA's scheduled shifts
-- still come from 7shifts via Culture Pulse. CAKE = actuals only.
--
-- cake_account_id is stored here so the (deferred) CAKE feed can resolve a
-- location to its CAKE account without a separate lookup. NOLA = 11527572.
--
-- Default '7shifts' preserves existing behavior for all 8 locations; setting
-- NOLA -> 'cake' is inert until the orchestrator change ships.
--
-- Additive only. Safe to (re-)apply on prod (uyjlnciqecfcxsooupaa).
-- ============================================================================

alter table public.locations
  add column if not exists actuals_source text not null default '7shifts'
    check (actuals_source in ('7shifts', 'cake')),
  add column if not exists cake_account_id text;

update public.locations
set actuals_source = 'cake',
    cake_account_id = '11527572'
where location_code = 'NOLA';
