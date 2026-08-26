-- 070: effective_period_start — CORRECTED derivation (demarcation spec
-- 2026-08-26 rev 3 §2b-i; caught by Training HQ before they consumed it).
--
-- 069's unconditional greatest(period_start, floor) LIES about 216 real
-- values: the frozen quarters sit below every store's floor AND carry real
-- scores — computed before the floor existed, guaranteed never recomputed
-- (§1d-ii). greatest() over FCOL's Q3 2025 yields 2026-07-08 > period_end
-- → "never measurable" rendered over a tile showing 75.0%. Both facts are
-- true; the unconditional clamp is what lies.
--
-- THE RULE (reason from this if a new case appears): effective_period_start
-- describes what the ROW measured, not what today's policy would measure.
-- A row scored under a previous regime keeps its own window.
--
-- Corrected derivation, both parts required (§2b-i):
--   frozen period            → period_start   (the row measured its full window)
--   data_start_date is null  → period_start   (no floor — NOLA; explicit
--                              branch, NEVER greatest()'s null handling:
--                              engine-dependent null behaviour is exactly
--                              where a silent wrong answer hides)
--   else                     → greatest via explicit comparison
--
-- Known, accepted residue (§2b-ii / §8a): populated-but-not-frozen rows
-- below the floor (Q1/Q2 2026) carry the clamped window until the
-- immediate post-deploy recompute nulls them — the deploy window collapsed
-- from days to minutes by §8a's reordering, and consumers gate on the
-- METRIC first (a non-null metric outranks the window fields; the window
-- explains an absence, never contradicts a presence).
--
-- §2b-iii rides the same emissions and is pinned in the contract test:
-- period_label stays a bare period name (rp.label pass-through) — window
-- state lives ONLY in data_start_date / effective_period_start; moving the
-- meaning into the label would route around the metric-outranks-window
-- rule through a display string.
--
-- Deltas vs 069: the effective_period_start expression in v_employee_scores
-- (the _latest view inherits it via s.*-column pass-through). Everything
-- else byte-identical, including the §1d restoration (no active filter on
-- the history view; active-only via re-join on _latest).

create or replace view public.v_employee_scores
with (security_invoker = true) as
select
  e.employee_code                              as employee_code,
  e.email                                      as employee_email,
  l.location_code                              as location_code,
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
  -- 2 effective-window fields (appended 2026-08-26 mig 069; derivation
  -- corrected 070 per §2b-i — frozen rows keep their own window)
  l.metrics_start_date                         as data_start_date,
  case
    when rp.frozen                             then rp.period_start
    when l.metrics_start_date is null          then rp.period_start
    when l.metrics_start_date > rp.period_start then l.metrics_start_date
    else rp.period_start
  end                                          as effective_period_start
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
  -- 2 effective-window fields (appended 2026-08-26; 070 derivation inherited)
  s.data_start_date,
  s.effective_period_start
from public.v_employee_scores s
-- §1d/069: the ACTIVE-ONLY semantic lives HERE — the latest view is the
-- current-state feed; the history view above serves every stored row.
join public.employees e
  on e.employee_code = s.employee_code
join public.locations l
  on l.id = e.location_id and l.location_code = s.location_code
where e.active
order by s.employee_code, s.location_code, s.period_start desc;
