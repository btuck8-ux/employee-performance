-- ============================================================================
-- 036_ingest_runs_allow_guest_feedback.sql — widen ingest_runs.source CHECK
-- ============================================================================
-- The unified guest-feedback harvester logs its runs in ingest_runs, reusing
-- the Phase 11 run-logging plumbing (startRun/finishRun). It adds two new
-- sources:
--   'tattle'  — Tattle Snapshot responses  (one run per location)
--   'reviews' — Tattle Online Reviews      (one run per location)
-- and REUSES the existing '7tasks' source for per-employee 7Tasks, which now
-- writes real tasks/task_accountability/task_owners rows (superseding the
-- log-only nightly 7tasks step for the stores the harvester covers).
--
-- Migration 032 widened the CHECK to admit 'cake_timesheets'; this widens it to
-- admit 'tattle' and 'reviews' (handoff §4c).
--
-- Idempotent (drop-if-exists + re-add). Safe to (re-)apply on prod. Apply to
-- prod via Supabase MCP for repo<->prod parity (the 030-035 pattern).
-- ============================================================================

alter table public.ingest_runs
  drop constraint if exists ingest_runs_source_check;

alter table public.ingest_runs
  add constraint ingest_runs_source_check
  check (source in (
    '7shifts_time',
    '7tasks',
    'pos_receipts',
    'cake_timesheets',
    'tattle',
    'reviews'
  ));
