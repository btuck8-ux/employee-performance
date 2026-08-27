-- 086: seven_shifts_user_id + on_time_count on the scores wire (packet 8
-- §3 — Tucker-approved 2026-08-27: "Call 1 — Yes, add the
-- seven_shifts_user_id — APPROVED. Call 2 — Yes add on_time_count —
-- APPROVED.").
--
-- Both ADDITIVE. No existing value changes; no row appears or disappears.
-- Wire: both views re-emitted from 083's text with the pair APPENDED after
-- attended_count — 30 → 32 keys, nothing reordered, nothing renamed (the
-- additive-only motion of migs 045/048/069/083). Both columns ride both
-- views, so the two surfaces cannot disagree.
--
-- SEQUENCING (packet 8 §1e): this migration ships BEFORE the §7.7.3
-- cross-store rule. CP attaches its orphans on this column and must see the
-- pre-rule values (82.353 / 83.333) as published before observing the move.
-- Rule-first would make the announced change unobservable.
--
-- seven_shifts_user_id: sourced from employees.seven_shifts_user_id on the
-- row the score belongs to (the pr.employee_id join). NULLABLE — NEVER
-- coalesced: a null must stay null so a consumer cannot join nulls to each
-- other. 0 of 238 rows are null today; the discipline is for the day one
-- isn't. Both partners told, both accepted.
--
-- on_time_count: the number of ATTENDED days that fell within grace — the
-- GRACE count (internal metrics.on_time_grace_count), NOT the strict
-- on-time count, and its denominator is attended_count, NOT
-- scheduled_count. Identities, pinned as tests and re-run after the
-- cross-store rule (§1d — the rule moves COUNTS, not just percentages):
--   on_time_grace_pct = on_time_count / attended_count   when attended_count > 0
--   attendance_pct    = attended_count / scheduled_count when scheduled_count > 0
-- (a cover-dominated row carries real counts under a null pct — the ruled
-- 083 shape; the identity is asserted where the pct is non-null.)
--
-- NULL SEMANTICS (the feed's standing discipline — null = not-computed,
-- never 0): null = pre-086 row not yet recomputed, ruling-8 excluded
-- non-puncher, or a frozen row (frozen rows are never recomputed and never
-- acquire the count — on_time_count inherits the 083 boundary: the null
-- population lands exactly on Q3 2025 + Q4 2025). NO backfill; NO default.
-- 0 is a real value: the person attended nothing on time.
--
-- Writer: recomputePerformanceForQuarter stamps on_time_count from
-- metrics.on_time_grace_count behind the same punchesTimeClock gate as the
-- 083 pair. No SQL scoring twin reads it — nothing to keep in lockstep
-- beyond the view.

alter table public.performance_records
  add column if not exists on_time_count integer;

comment on column public.performance_records.on_time_count is
  'Attended days that fell within grace (packet 8 §3, approved 2026-08-27). '
  'The GRACE count — identity: on_time_grace_pct = on_time_count / '
  'attended_count. Denominator is attended_count, never scheduled_count. '
  'NULL = not computed (pre-086 row, frozen row, or ruling-8 excluded '
  'non-puncher — null, never 0). Written only by the quarterly recompute.';

-- ── v_employee_scores: 083 verbatim + the 2 columns appended ───────────────

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
  end                                          as effective_period_start,
  -- 2 attendance count fields (appended 2026-08-26 mig 083 — THQ wire
  -- item 1; null = not-computed / ruling-8 excluded, never 0)
  pr.scheduled_count                           as scheduled_count,
  pr.attended_count                            as attended_count,
  -- identity key + on-time count (appended 2026-08-27 mig 086, packet 8
  -- §3 — Tucker-approved; the uid is NEVER coalesced: null stays null)
  e.seven_shifts_user_id                       as seven_shifts_user_id,
  pr.on_time_count                             as on_time_count
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
  s.effective_period_start,
  -- 2 attendance count fields (appended 2026-08-26 mig 083)
  s.scheduled_count,
  s.attended_count,
  -- identity key + on-time count (appended 2026-08-27 mig 086)
  s.seven_shifts_user_id,
  s.on_time_count
from public.v_employee_scores s
-- §1d/069: the ACTIVE-ONLY semantic lives HERE — the latest view is the
-- current-state feed; the history view above serves every stored row.
join public.employees e
  on e.employee_code = s.employee_code
join public.locations l
  on l.id = e.location_id and l.location_code = s.location_code
where e.active
order by s.employee_code, s.location_code, s.period_start desc;
