-- ============================================================================
-- 039_ingest_runs_allow_culture_pulse.sql — widen ingest_runs.source CHECK
-- ============================================================================
-- The CP→EPD survey feed (handoff-cp-survey-feed-EXECUTE-2026-07-26.md) logs
-- its nightly per-store runs in ingest_runs under source 'culture_pulse',
-- reusing the Phase 11 run plumbing (startRun/finishRun) like every other
-- feed. This is the ingestion leg that replaces the worked-pool survey
-- denominator with CP's actual send log.
--
-- Migration 038 added 'toast_sales' to this same CHECK; the re-add below MUST
-- keep listing it (drop+re-add semantics) or the Toast feed breaks.
--
-- Idempotent (drop-if-exists + re-add). Apply to prod via Supabase MCP for
-- repo<->prod parity (the 030-038 pattern).
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
    'reviews',
    'toast_sales',
    'culture_pulse'
  ));
