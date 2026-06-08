-- ============================================================================
-- 032_ingest_runs_allow_cake_timesheets.sql — widen ingest_runs.source CHECK
-- ============================================================================
-- The durable CAKE actuals feed logs its runs in ingest_runs with
-- source = 'cake_timesheets', reusing the Phase 11 run-logging plumbing
-- (startRun/finishRun). Migration 030 created the CHECK with only the 7shifts
-- trio; this widens it to admit the CAKE source.
--
-- APPLIED TO PROD via Supabase MCP on 2026-06-08 (version 20260608215125)
-- during the NOLA CAKE backfill (decisions-log-cake-ingest-2026-06-08.md);
-- committed here for repo<->prod parity, same pattern as migration 030.
--
-- Idempotent (drop-if-exists + re-add). Safe to (re-)apply on prod.
-- ============================================================================

alter table public.ingest_runs
  drop constraint if exists ingest_runs_source_check;

alter table public.ingest_runs
  add constraint ingest_runs_source_check
  check (source in ('7shifts_time', '7tasks', 'pos_receipts', 'cake_timesheets'));
