-- ============================================================================
-- 049_ingest_runs_allow_cp_schedule.sql — admit the CP schedule feed source
-- ============================================================================
-- The CP→EPD scheduled-shifts feed (kickoff-ui-rbac-c-brand-2026-08-14.md §3)
-- logs one ingest_runs row per store per night under source 'cp_schedule'.
-- ingest_runs.source carries a CHECK constraint (030, expanded 032/036/038/
-- 039/041) — this is the same drop-and-recreate expansion, nothing else.
--
-- ORDERING: apply BEFORE the feed/cp-schedule-feed PR merges (§7 mechanics —
-- Cowork/Tucker applies via MCP; this file is the parity copy). The feed's
-- startRun() would otherwise fail the CHECK and the nightly would run
-- unlogged. Safe to apply ahead of the code: purely additive to the allowed
-- set.
-- ============================================================================

alter table public.ingest_runs drop constraint if exists ingest_runs_source_check;
alter table public.ingest_runs add constraint ingest_runs_source_check check (source = any (array[
  '7shifts_time','7tasks','pos_receipts','cake_timesheets',
  'tattle','reviews','toast_sales','culture_pulse','toast_kitchen',
  'cp_schedule']));
