-- 069: the effective-window wire contract (demarcation spec 2026-08-26
-- §2b, THQ-accepted verbatim) + §1d restoration: history survives archiving.
--
-- TWO KEYS, APPENDED — nothing reordered, nothing removed, nothing renamed
-- (the same motion as the six count fields in August):
--
--   data_start_date         "YYYY-MM-DD" | null — the location's
--                           metrics_start_date. null = NO FLOOR (currently
--                           NOLA only); never read as "floors at epoch" or
--                           "floors today".
--   effective_period_start  "YYYY-MM-DD" — the first day actually scored
--                           for this row: greatest(period_start,
--                           data_start_date), or period_start when there
--                           is no floor. NEVER null, present on EVERY row
--                           of every period — absence must never be the
--                           encoding for "no clamp applied" (§2b).
--
-- Key count rises by exactly two: 26 → 28. Assert on both sides.
-- Consumer semantics (§2b): effective_period_start > period_end = period
-- entirely below the floor ("Data begins <date>", never "not yet");
-- > period_start = partial period; == period_start = unclamped.
--
-- ⚠️ SECOND DELTA — §1d RESTORATION: `where e.active` is REMOVED from
-- v_employee_scores. Measured 2026-08-26 while wiring the §1d-i pin: the
-- stored table holds Q3 2025 = 160 / Q4 2025 = 178 rows intact, but the
-- served view filtered them to 125/141 — the 2026-08-26 archiving of 40+
-- departed employees silently removed 72 frozen-quarter rows from THQ's
-- wire. §1d is a ruling: "the feed serves stored history unchanged"; the
-- fingerprints exist to detect exactly this. History belongs to the
-- period, not to current employment — an employee who earned a 2025 score
-- did so whether or not they still work here. The ACTIVE-ONLY semantic
-- moves to where it belongs: v_employee_scores_latest (the current-state
-- view) re-joins employees and keeps serving active staff only, so CP's
-- daily current pull is population-identical to before the archiving.
--
-- security_invoker + DISTINCT ON latest semantics carried over verbatim
-- (028/029/045/048). No route change (select("*")), no policy change.

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
  pr.tasks_completed                           as tasks_completed,
  -- 2 effective-window fields (appended 2026-08-26, §2b — THQ contract)
  l.metrics_start_date                         as data_start_date,
  greatest(
    rp.period_start,
    coalesce(l.metrics_start_date, rp.period_start)
  )                                            as effective_period_start
from public.performance_records pr
join public.employees      e  on e.id  = pr.employee_id
join public.locations      l  on l.id  = pr.location_id
join public.report_periods rp on rp.id = pr.report_period_id;

create or replace view public.v_employee_scores_latest
with (security_invoker = true) as
select distinct on (s.employee_code, s.location_code)
  s.employee_code,
  s.employee_email,
  s.location_code,
  s.period_label,
  s.period_start,
  s.period_end,
  s.customer_service_score,
  s.total_impact_score,
  s.cs_components_count,
  s.tis_components_count,
  s.computed_at,
  -- 9 individual metrics (appended 2026-08-10, mig 045)
  s.on_time_grace_pct,
  s.attendance_pct,
  s.survey_engagement_pct,
  s.customer_service_rating,
  s.tattle_rating,
  s.tattle_score_food_quality,
  s.tattle_score_accuracy,
  s.tattle_score_speed_of_service,
  s.avg_task_list_completion_pct,
  -- 6 per-metric count fields (appended 2026-08-12; same order as v_employee_scores)
  s.surveys_assigned,
  s.surveys_completed,
  s.customer_review_quantity,
  s.tattle_quantity,
  s.tasks_accountable,
  s.tasks_completed,
  -- 2 effective-window fields (appended 2026-08-26, §2b)
  s.data_start_date,
  s.effective_period_start
from public.v_employee_scores s
-- §1d/069: the ACTIVE-ONLY semantic lives HERE now — the latest view is
-- the current-state feed; the history view above serves every stored row.
join public.employees e
  on e.employee_code = s.employee_code
join public.locations l
  on l.id = e.location_id and l.location_code = s.location_code
where e.active
order by s.employee_code, s.location_code, s.period_start desc;
