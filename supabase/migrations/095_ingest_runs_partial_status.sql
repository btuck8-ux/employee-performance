-- 095: ingest_runs accepts the `partial` terminal status (MASTER sprint W7).
--
-- ⚠️ NOT YET APPLIED TO PRODUCTION. Application is W7 gate 5a (Tucker).
-- ⚠️ DEPLOYMENT ORDER IS LOAD-BEARING and this migration is FIRST, not
-- last: the database must accept `partial` before any deployed producer can
-- emit it. The order is:
--   1. this migration (G4);
--   2. application deployed with producers present but INERT — the runtime
--      flag INGEST_PARTIAL_STATUS_ENABLED is unset (the mechanism keeping
--      behaviour dormant is that explicit flag, NOT a scheduling
--      assumption; merge auto-deploys);
--   3. CP compatibility evidence obtained (additive-only on the wire);
--   4. activation: INGEST_PARTIAL_STATUS_ENABLED=1 (gate 5b — a separate
--      approval from this migration's).
--
-- Widening this constraint causes NO producer to emit `partial` — emission
-- is gated in code (applyPartialPolicy, flag off = byte-identical).
--
-- Meaning (the rule, pinned by partial-status tests):
--   error   = nothing trustworthy completed;  empty = window held nothing;
--   success = the whole work plan completed;  partial = rows landed AND a
--   unit of the run's own plan terminally failed.
-- RULED both-or-neither: partial ALERTS and does NOT advance
-- lastSuccessfulWindowEnd (it is deliberately absent from that reader's
-- status list, so the next run re-pulls the window; upserts make the
-- re-pull idempotent).

alter table public.ingest_runs
  drop constraint if exists ingest_runs_status_check;

alter table public.ingest_runs
  add constraint ingest_runs_status_check
  check (status in ('running', 'success', 'empty', 'error', 'partial'));

comment on column public.ingest_runs.status is
  'running | success | empty | error | partial. partial (W7): rows landed but part of the run''s own work plan terminally failed — alerts, and never advances the incremental watermark.';
