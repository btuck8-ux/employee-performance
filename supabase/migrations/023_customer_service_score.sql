-- ============================================================================
-- 023_customer_service_score.sql — Phase 9: compute function + storage columns
-- ============================================================================
-- The composite score is computed from three normalized 0–100 components:
--
--   Tattle  : (tattle_rating  − 1) / 4 × 100              [clamped 0..100]
--   Reviews : (review_rating  − 1) / 4 × 100              [clamped 0..100]
--   Tip     : (tip_delta_pp + 2) / 4 × 100                [clamped 0..100]
--
-- Weights come from the customer_service_score_config singleton (mig 022).
-- Null handling (per spec):
--   3 of 3 present  → composite = sum(weight_i × score_i). No flag.
--   2 of 3 present  → re-weight pro-rata; composite computed; components_count=2.
--   1 of 3 present  → NOT a composite. Function returns NULL composite +
--                     components_count=1 so callers can render the "single-
--                     source" view (raw rating shown with annotation).
--   0 of 3 present  → composite NULL; components_count=0.
--
-- Performance_records gains two persisted columns:
--   customer_service_score                  numeric(5,2)  -- composite, may be NULL
--   customer_service_score_components_count smallint      -- 0..3
--
-- The per-component 0–100 scores and effective weights are NOT persisted —
-- they're cheap to derive from the rating/delta columns already stored. The
-- TypeScript helper at src/lib/customer-service-score.ts is the source of
-- truth for runtime / display math; the SQL function below mirrors it so
-- SQL-side queries (and ad-hoc analysis) can stay consistent.
-- ============================================================================

alter table public.performance_records
  add column customer_service_score                   numeric(5,2),
  add column customer_service_score_components_count  smallint;

-- ----------------------------------------------------------------------------
-- compute_customer_service_score_breakdown
-- Pure-arithmetic SQL function. Takes the three native inputs (Tattle avg
-- rating, customer-reviews avg rating, tip-rate delta in pp) and the three
-- configured weights; returns the composite, per-component 0–100 scores,
-- effective weights after pro-rata re-weighting, and the component count.
-- Marked IMMUTABLE because output depends solely on inputs.
-- ----------------------------------------------------------------------------
create or replace function public.compute_customer_service_score_breakdown(
  p_tattle_rating       numeric,
  p_reviews_rating      numeric,
  p_tip_rate_delta_pp   numeric,
  p_weight_tattle       numeric,
  p_weight_reviews      numeric,
  p_weight_tip          numeric
) returns table (
  composite_score             numeric,
  components_count            smallint,
  tattle_component_score      numeric,
  reviews_component_score     numeric,
  tip_component_score         numeric,
  effective_weight_tattle     numeric,
  effective_weight_reviews    numeric,
  effective_weight_tip        numeric
) language sql immutable as $$
  with raw as (
    select
      case when p_tattle_rating is not null
        then greatest(0, least(100, ((p_tattle_rating - 1) / 4.0) * 100))
      end as t_score,
      case when p_reviews_rating is not null
        then greatest(0, least(100, ((p_reviews_rating - 1) / 4.0) * 100))
      end as r_score,
      case when p_tip_rate_delta_pp is not null
        then greatest(0, least(100, ((p_tip_rate_delta_pp + 2) / 4.0) * 100))
      end as p_score
  ),
  presence as (
    select
      t_score, r_score, p_score,
      case when t_score is not null then p_weight_tattle  else 0 end as w_t,
      case when r_score is not null then p_weight_reviews else 0 end as w_r,
      case when p_score is not null then p_weight_tip     else 0 end as w_p,
      ((case when t_score is not null then 1 else 0 end)
       + (case when r_score is not null then 1 else 0 end)
       + (case when p_score is not null then 1 else 0 end))::smallint as cnt
    from raw
  ),
  effective as (
    select
      t_score, r_score, p_score, cnt,
      (w_t + w_r + w_p) as w_sum,
      case when cnt >= 2 and (w_t + w_r + w_p) > 0 then w_t / (w_t + w_r + w_p) end as ew_t,
      case when cnt >= 2 and (w_t + w_r + w_p) > 0 then w_r / (w_t + w_r + w_p) end as ew_r,
      case when cnt >= 2 and (w_t + w_r + w_p) > 0 then w_p / (w_t + w_r + w_p) end as ew_p
    from presence
  )
  select
    case when cnt >= 2 then
      coalesce(ew_t * t_score, 0) + coalesce(ew_r * r_score, 0) + coalesce(ew_p * p_score, 0)
    end                  as composite_score,
    cnt                  as components_count,
    t_score              as tattle_component_score,
    r_score              as reviews_component_score,
    p_score              as tip_component_score,
    ew_t                 as effective_weight_tattle,
    ew_r                 as effective_weight_reviews,
    ew_p                 as effective_weight_tip
  from effective;
$$;
