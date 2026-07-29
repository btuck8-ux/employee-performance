-- ============================================================================
-- 044_kitchen_fn_plan_cache_and_comment.sql — force custom plans on the
-- kitchen functions + correct 043's stale residual column comment
-- ============================================================================
-- 1. plan_cache_mode. Diagnosed live 2026-07-29 during the post-merge Q3
--    recompute: compute_kitchen_speed executes in ~34ms under a custom plan
--    but exceeds the 8s statement_timeout PostgREST sessions inherit from
--    the authenticator role under a GENERIC plan (reproduced directly with
--    set local plan_cache_mode = force_generic_plan). plpgsql switches
--    cached queries to the generic plan after ~5 executions per connection,
--    so pooled RPC traffic — the nightly recompute, bulk backfills — starts
--    fast and then times out en masse; fetchKitchenMetrics catches the error
--    and silently stores null kitchen columns. Forcing custom plans costs
--    ~2.5ms planning per call against a ~34ms execution — negligible — and
--    keeps the parameter-aware index paths.
-- ----------------------------------------------------------------------------
alter function public.compute_kitchen_speed(uuid, uuid, date, date)
  set plan_cache_mode = force_custom_plan;
alter function public.compute_location_kitchen_speed(uuid, date, date)
  set plan_cache_mode = force_custom_plan;
alter function public.kitchen_hourly_baseline(uuid, date, date)
  set plan_cache_mode = force_custom_plan;

-- ----------------------------------------------------------------------------
-- 2. 043's column comment predated the 1.5.2 amendment (the 15-shift floor
--    is advisory, not a storage gate) — the residual is stored at any shift
--    count whenever attributed items exist.
-- ----------------------------------------------------------------------------
comment on column public.performance_records.kitchen_residual_seconds is
  'avg prep minus the store''s same-hour baseline over the employee''s attributed items; negative = faster than norm. Stored at ANY shift count (the 15-shift floor is advisory: below it the PDF withholds the rating badge and marks figures directional only). Supersedes kitchen_prep_delta_seconds (043; amended 1.5.2).';
