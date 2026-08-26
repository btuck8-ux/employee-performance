-- 083: scheduled_count + attended_count on the scores wire (THQ wire item 1,
-- packet 5 §7.3 — THQ-confirmed 2026-08-26, built FIRST by their order).
--
-- ⛔ FILE-ONLY until the denominator branch's gated merge motion — this
-- rides feat/removed-shift-denominator behind the same gate as mig 079.
-- (081/082 are reserved: 081 = drop q2_gap_ledger, 082 = roster parity.)
--
-- THQ's reasoning, recorded: "a bare 0% beside nine other percentages is an
-- accusation the wire cannot substantiate; 0 of 5 is a fact." The quarterly
-- tiles are the live coaching surface and the demarcation floor
-- systematically thins their denominators — the counts substantiate the
-- percentage.
--
-- NULL SEMANTICS (the feed's standing discipline — null = not-computed,
-- never 0):
--   null    the row predates this migration's recompute, OR the employee is
--           excluded from the attendance denominator (punches_time_clock =
--           false — ruling 8: "null, never 0"; the excluded person's
--           scheduled days exist but are deliberately not judged, so a 0
--           here would be a false count, the exact accusation shape the
--           counts exist to prevent).
--   integer computed. 0 = honestly none in the window (including a period
--           wholly below the store's floor: zero judgeable days). The
--           cover-dominated guard follows its ruled shape — counts stay
--           real; only the percentages go not-computable.
--
-- Wire: both views re-emitted from 070's text with the pair APPENDED after
-- effective_period_start — 28 → 30 keys, nothing reordered, nothing renamed
-- (the additive-only motion of migs 045/048/069). Straight pr.<col>
-- pass-through so SQL null reaches the wire as JSON null.
--
-- Writers: recomputePerformanceForQuarter (TS) stamps both on every write.
-- No SQL scoring twin exists for attendance metrics — the composites' twins
-- (023/025) don't read counts; nothing to keep in lockstep beyond the view.

alter table public.performance_records
  add column if not exists scheduled_count integer,
  add column if not exists attended_count  integer;

comment on column public.performance_records.scheduled_count is
  'Scored scheduled-shift denominator for the period (THQ wire item, packet '
  '5 §7.3). NULL = not computed (pre-083 row, or attendance-denominator-'
  'excluded non-puncher — ruling 8: null, never 0). 0 = computed, zero '
  'judgeable scheduled days. Written only by the quarterly recompute.';

comment on column public.performance_records.attended_count is
  'Attended count against scheduled_count (THQ wire item, packet 5 §7.3). '
  'Same null semantics as scheduled_count. A removed-but-punched day counts '
  'attended by construction (denominator spec rev 2 §2).';

-- ── v_employee_scores: 070 verbatim + the 2 count columns appended ─────────

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
  pr.attended_count                            as attended_count
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
  s.attended_count
from public.v_employee_scores s
-- §1d/069: the ACTIVE-ONLY semantic lives HERE — the latest view is the
-- current-state feed; the history view above serves every stored row.
join public.employees e
  on e.employee_code = s.employee_code
join public.locations l
  on l.id = e.location_id and l.location_code = s.location_code
where e.active
order by s.employee_code, s.location_code, s.period_start desc;
