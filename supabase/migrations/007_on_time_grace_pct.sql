-- ============================================================================
-- Track two punctuality metrics:
--   on_time_pct        = strict comparison (existing)
--   on_time_grace_pct  = with a 3-minute grace period (new)
-- ============================================================================
alter table public.performance_records
  add column on_time_grace_pct numeric;
