-- 048_v_employee_scores_count_fields
-- Scores Feed Enhancement #2 (kickoff-scores-counts-2026-08-12.md): append
-- the six per-metric COUNT fields behind the composites/metrics for THQ's
-- Sprint-2 Performance Center (daily 11:15 UTC poll; CP 09:00 UTC unaffected).
-- Wire names are FINAL per memo-to-training-hq-scores-counts-2026-08-12.md —
-- they mirror the performance_records columns, in this exact order:
--   surveys_assigned, surveys_completed, customer_review_quantity,
--   tattle_quantity, tasks_accountable, tasks_completed.
--
-- Additive contract (same as 045): `create or replace view` re-emits the
-- existing 20 columns VERBATIM (names/order/types, copied from mig 045 —
-- canonical) and appends the 6 at the END; the engine enforces the shape both
-- live consumers parse. Straight pr.* pass-through — NO coalesce/nullif:
-- null = not-computed (CSV-era Q3'24–Q2'25 rows emit all-null counts,
-- expected + disclosed to THQ), 0 = a real computed zero (317 live
-- surveys_completed=0 rows exist; null ≠ 0 is load-bearing).
--
-- Known nuance (disclosed to THQ, deliberately NOT "fixed" here):
-- tasks_accountable/tasks_completed arithmetically back task_completion_pct
-- (not on the wire), not avg_task_list_completion_pct (the emitted TIS
-- component, a list-level average). They ship as context counts regardless;
-- no derived fields are added.
--
-- security_invoker + `where e.active` carried over verbatim (028/045);
-- latest-view DISTINCT ON semantics carried over verbatim (029/045).
-- No route change (select("*")), no policy change, no proxy change.

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
  -- 9 individual metrics (appended 2026-08-10, mig 045)
  pr.on_time_grace_pct                         as on_time_grace_pct,
  pr.attendance_pct                            as attendance_pct,
  pr.survey_engagement_pct                     as survey_engagement_pct,
  pr.customer_service_rating                   as customer_service_rating,
  pr.tattle_rating                             as tattle_rating,
  pr.tattle_score_food_quality                 as tattle_score_food_quality,
  pr.tattle_score_accuracy                     as tattle_score_accuracy,
  pr.tattle_score_speed_of_service             as tattle_score_speed_of_service,
  pr.avg_task_list_completion_pct              as avg_task_list_completion_pct,
  -- 6 per-metric count fields (appended 2026-08-12; names = performance_records columns)
  pr.surveys_assigned                          as surveys_assigned,
  pr.surveys_completed                         as surveys_completed,
  pr.customer_review_quantity                  as customer_review_quantity,
  pr.tattle_quantity                           as tattle_quantity,
  pr.tasks_accountable                         as tasks_accountable,
  pr.tasks_completed                           as tasks_completed
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
  -- 9 individual metrics (appended 2026-08-10, mig 045)
  on_time_grace_pct,
  attendance_pct,
  survey_engagement_pct,
  customer_service_rating,
  tattle_rating,
  tattle_score_food_quality,
  tattle_score_accuracy,
  tattle_score_speed_of_service,
  avg_task_list_completion_pct,
  -- 6 per-metric count fields (appended 2026-08-12; same order as v_employee_scores)
  surveys_assigned,
  surveys_completed,
  customer_review_quantity,
  tattle_quantity,
  tasks_accountable,
  tasks_completed
from public.v_employee_scores
order by employee_code, location_code, period_start desc;
