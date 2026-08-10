-- 045_v_employee_scores_metrics
-- Additively extend the scores feed (GET /api/scores) with the 9 individual
-- metrics behind the CS/TIS composites, for Training HQ (daily 11:15 UTC poll)
-- and optionally Culture Pulse (daily 09:00 UTC poll).
--
-- Wire naming LOCKED (Tucker, 2026-08-10): mirror the internal
-- performance_records column names verbatim — see
-- memo-to-training-hq-scores-feed-naming-2026-08-10.md. Notes:
--   * on_time_grace_pct is the grace-aware On Time % (ON_TIME_GRACE_MINUTES=3),
--     the value the dashboard/PDF show and the TIS input. Strict on_time_pct is
--     deliberately NOT emitted.
--   * avg_task_list_completion_pct is the TIS tasks component ("7Tasks
--     Completion %"), NOT task_completion_pct / task_list_completion_pct.
--
-- Additive contract: `create or replace view` only permits re-emitting the
-- existing columns in the same order/names/types with new columns appended at
-- the END — the engine itself enforces that the existing 11-field consumer
-- shape (CP) is unchanged. Straight pr.* pass-through, no coalesce/nullif:
-- null = not-computed (never 0), 0 = a real computed zero.
--
-- security_invoker + the `where e.active` filter carried over verbatim from
-- 028; the latest-view semantics (DISTINCT ON, period_start desc) from 029.

create or replace view public.v_employee_scores
with (security_invoker = true) as
select
  e.employee_code                              as employee_code,   -- PRIMARY join key (100%, unique, durable)
  e.email                                      as employee_email,  -- secondary / reconciliation only
  l.location_code                              as location_code,   -- shared code (CPD...), NOT location_key
  rp.label                                     as period_label,
  rp.period_start                              as period_start,
  rp.period_end                                as period_end,
  pr.customer_service_score                    as customer_service_score,
  pr.total_impact_score                        as total_impact_score,
  pr.customer_service_score_components_count   as cs_components_count,
  pr.total_impact_score_components_count       as tis_components_count,
  pr.updated_at                                as computed_at,
  -- 9 individual metrics (appended 2026-08-10; names = performance_records columns)
  pr.on_time_grace_pct                         as on_time_grace_pct,
  pr.attendance_pct                            as attendance_pct,
  pr.survey_engagement_pct                     as survey_engagement_pct,
  pr.customer_service_rating                   as customer_service_rating,
  pr.tattle_rating                             as tattle_rating,
  pr.tattle_score_food_quality                 as tattle_score_food_quality,
  pr.tattle_score_accuracy                     as tattle_score_accuracy,
  pr.tattle_score_speed_of_service             as tattle_score_speed_of_service,
  pr.avg_task_list_completion_pct              as avg_task_list_completion_pct
from public.performance_records pr
join public.employees      e  on e.id  = pr.employee_id
join public.locations      l  on l.id  = pr.location_id
join public.report_periods rp on rp.id = pr.report_period_id
where e.active;

create or replace view public.v_employee_scores_latest
with (security_invoker = true) as
select distinct on (employee_code, location_code)
  employee_code,
  employee_email,
  location_code,
  period_label,
  period_start,
  period_end,
  customer_service_score,
  total_impact_score,
  cs_components_count,
  tis_components_count,
  computed_at,
  -- 9 individual metrics (appended 2026-08-10; same order as v_employee_scores)
  on_time_grace_pct,
  attendance_pct,
  survey_engagement_pct,
  customer_service_rating,
  tattle_rating,
  tattle_score_food_quality,
  tattle_score_accuracy,
  tattle_score_speed_of_service,
  avg_task_list_completion_pct
from public.v_employee_scores
order by employee_code, location_code, period_start desc;
