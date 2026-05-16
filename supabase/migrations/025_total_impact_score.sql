-- ============================================================================
-- 025_total_impact_score.sql — Phase 10: compute function + storage columns
-- ============================================================================
-- The composite Total Impact Score is computed from five 0–100 component
-- inputs (each already on a 0–100 scale on performance_records):
--
--   Customer Service Score   : performance_records.customer_service_score
--   Attendance %             : performance_records.attendance_pct
--   On-time % (grace-aware)  : performance_records.on_time_grace_pct
--   Task completion %        : performance_records.avg_task_list_completion_pct
--   Survey engagement %      : performance_records.survey_engagement_pct
--
-- Weights come from the total_impact_score_config singleton (mig 024).
--
-- Null handling (per spec):
--   ≥4 of 5 present  → composite = sum(effective_weight_i × score_i),
--                      with pro-rata re-weighting on the available components.
--   < 4 of 5 present → composite NULL; the employee is NOT ranked this range.
--
-- Critical sub-rule on the CS Score input: CS Score's single-source state
-- (Phase 9 components_count = 1) is NOT a real composite — Phase 9 writes
-- customer_service_score = NULL in that case. So a non-null CS Score here
-- already encodes "2-of-3 or 3-of-3 composite present"; we just null-check.
--
-- Each component is defensively clamped to [0, 100] after read (CS Score
-- already clamps; the percent columns are bounded by their compute logic
-- but uploaded data could theoretically slip through outside the band).
--
-- Performance_records gains two persisted columns:
--   total_impact_score                         numeric(5,2)  -- composite, may be NULL
--   total_impact_score_components_count        smallint      -- 0..5
--
-- Per-component scores + effective weights are NOT persisted — they're cheap
-- to derive from the existing component columns. The TypeScript helper at
-- src/lib/total-impact-score.ts is the source of truth for runtime / display
-- math; the SQL function below mirrors it so SQL-side queries (ranking
-- window functions especially) stay consistent.
--
-- Ranks are NEVER stored. They cascade across every employee in a scope
-- whenever any single TIS changes — denormalizing would force a global
-- recompute on every performance_records update. Computed on-demand via
-- SQL window functions (or in-memory for non-quarter ranges).
-- ============================================================================

alter table public.performance_records
  add column total_impact_score                  numeric(5,2),
  add column total_impact_score_components_count smallint;

-- ----------------------------------------------------------------------------
-- compute_total_impact_score_breakdown
-- Pure-arithmetic SQL function. Takes the five normalized 0–100 component
-- inputs plus the five configured weights; returns the composite, components
-- count, per-component 0–100 scores (clamped), and effective weights after
-- pro-rata re-weighting. Returns NULL composite when fewer than 4 components
-- are present. Marked IMMUTABLE because output depends solely on inputs.
-- ----------------------------------------------------------------------------
create or replace function public.compute_total_impact_score_breakdown(
  p_cs_score             numeric,
  p_attendance_pct       numeric,
  p_on_time_grace_pct    numeric,
  p_avg_task_list_pct    numeric,
  p_survey_engagement_pct numeric,
  p_weight_cs            numeric,
  p_weight_attendance    numeric,
  p_weight_on_time       numeric,
  p_weight_tasks         numeric,
  p_weight_survey        numeric
) returns table (
  composite_score              numeric,
  components_count             smallint,
  cs_component_score           numeric,
  attendance_component_score   numeric,
  on_time_component_score      numeric,
  tasks_component_score        numeric,
  survey_component_score       numeric,
  effective_weight_cs          numeric,
  effective_weight_attendance  numeric,
  effective_weight_on_time     numeric,
  effective_weight_tasks       numeric,
  effective_weight_survey      numeric
) language sql immutable as $$
  with raw as (
    select
      case when p_cs_score is not null
        then greatest(0, least(100, p_cs_score))
      end as cs_score,
      case when p_attendance_pct is not null
        then greatest(0, least(100, p_attendance_pct))
      end as att_score,
      case when p_on_time_grace_pct is not null
        then greatest(0, least(100, p_on_time_grace_pct))
      end as on_score,
      case when p_avg_task_list_pct is not null
        then greatest(0, least(100, p_avg_task_list_pct))
      end as tasks_score,
      case when p_survey_engagement_pct is not null
        then greatest(0, least(100, p_survey_engagement_pct))
      end as survey_score
  ),
  presence as (
    select
      cs_score, att_score, on_score, tasks_score, survey_score,
      case when cs_score     is not null then p_weight_cs         else 0 end as w_cs,
      case when att_score    is not null then p_weight_attendance else 0 end as w_att,
      case when on_score     is not null then p_weight_on_time    else 0 end as w_on,
      case when tasks_score  is not null then p_weight_tasks      else 0 end as w_tasks,
      case when survey_score is not null then p_weight_survey     else 0 end as w_survey,
      ((case when cs_score     is not null then 1 else 0 end)
       + (case when att_score    is not null then 1 else 0 end)
       + (case when on_score     is not null then 1 else 0 end)
       + (case when tasks_score  is not null then 1 else 0 end)
       + (case when survey_score is not null then 1 else 0 end))::smallint as cnt
    from raw
  ),
  effective as (
    select
      cs_score, att_score, on_score, tasks_score, survey_score, cnt,
      (w_cs + w_att + w_on + w_tasks + w_survey) as w_sum,
      case when cnt >= 4 and (w_cs + w_att + w_on + w_tasks + w_survey) > 0
        then w_cs     / (w_cs + w_att + w_on + w_tasks + w_survey) end as ew_cs,
      case when cnt >= 4 and (w_cs + w_att + w_on + w_tasks + w_survey) > 0
        then w_att    / (w_cs + w_att + w_on + w_tasks + w_survey) end as ew_att,
      case when cnt >= 4 and (w_cs + w_att + w_on + w_tasks + w_survey) > 0
        then w_on     / (w_cs + w_att + w_on + w_tasks + w_survey) end as ew_on,
      case when cnt >= 4 and (w_cs + w_att + w_on + w_tasks + w_survey) > 0
        then w_tasks  / (w_cs + w_att + w_on + w_tasks + w_survey) end as ew_tasks,
      case when cnt >= 4 and (w_cs + w_att + w_on + w_tasks + w_survey) > 0
        then w_survey / (w_cs + w_att + w_on + w_tasks + w_survey) end as ew_survey
    from presence
  )
  select
    case when cnt >= 4 then
        coalesce(ew_cs     * cs_score,     0)
      + coalesce(ew_att    * att_score,    0)
      + coalesce(ew_on     * on_score,     0)
      + coalesce(ew_tasks  * tasks_score,  0)
      + coalesce(ew_survey * survey_score, 0)
    end                  as composite_score,
    cnt                  as components_count,
    cs_score             as cs_component_score,
    att_score            as attendance_component_score,
    on_score             as on_time_component_score,
    tasks_score          as tasks_component_score,
    survey_score         as survey_component_score,
    ew_cs                as effective_weight_cs,
    ew_att               as effective_weight_attendance,
    ew_on                as effective_weight_on_time,
    ew_tasks             as effective_weight_tasks,
    ew_survey            as effective_weight_survey
  from effective;
$$;

-- ----------------------------------------------------------------------------
-- compute_tis_rankings_for_quarter
-- Returns one row per (employee × performance_records row) for the given
-- report_period_id, with eligibility flag and three precomputed ranks
-- (location, client, platform).
--
-- Eligibility = employees.active AND sum(worked hours at this location, all-
-- time) >= 40. Worked hours = sum of the four pay-bucket columns on
-- time_entries where entry_type='worked'. Ineligible employees still appear
-- in the result (rank columns are NULL for them) so the caller can render
-- them at the bottom if "show ineligible" is toggled on.
--
-- Ranks use rank() (competition ranking: 1, 1, 3, 4 on ties). NULL TIS rows
-- are excluded from the rank pool but still returned with NULL ranks so the
-- caller can render "—" for the rank cell.
--
-- The "*_total" companion columns express the size of the eligible-AND-
-- ranked population in each scope, so the UI can render "Loc 3 of 12"
-- without a separate count query.
-- ----------------------------------------------------------------------------
create or replace function public.compute_tis_rankings_for_quarter(
  p_report_period_id uuid
) returns table (
  employee_id              uuid,
  employee_name            text,
  location_id              uuid,
  location_name            text,
  client_id                uuid,
  client_name              text,
  active                   boolean,
  total_impact_score       numeric,
  components_count         smallint,
  all_time_hours_worked    numeric,
  eligible                 boolean,
  location_rank            int,
  location_total           int,
  client_rank              int,
  client_total             int,
  platform_rank            int,
  platform_total           int
) language sql stable as $$
  with hours_by_emp as (
    select
      te.employee_id,
      te.location_id,
      sum(
          coalesce(te.regular_hours,    0)
        + coalesce(te.ot_hours,         0)
        + coalesce(te.double_ot_hours,  0)
        + coalesce(te.holiday_hours,    0)
      ) as hours_worked
    from public.time_entries te
    where te.entry_type = 'worked'
    group by te.employee_id, te.location_id
  ),
  base as (
    select
      e.id            as employee_id,
      e.employee_name as employee_name,
      l.id            as location_id,
      l.name          as location_name,
      c.id            as client_id,
      c.name          as client_name,
      e.active        as active,
      pr.total_impact_score,
      pr.total_impact_score_components_count as components_count,
      coalesce(h.hours_worked, 0) as all_time_hours_worked,
      (e.active = true and coalesce(h.hours_worked, 0) >= 40) as eligible
    from public.performance_records pr
    join public.employees e  on e.id = pr.employee_id
    join public.locations l  on l.id = pr.location_id
    join public.clients   c  on c.id = l.client_id
    left join hours_by_emp h on h.employee_id = e.id and h.location_id = pr.location_id
    where pr.report_period_id = p_report_period_id
  ),
  -- Rank pool: only eligible employees with a non-null TIS get ranks. Ranks
  -- are competition ("rank()") so ties share a position and the next slot
  -- skips. Computed separately from the base set so ineligible rows don't
  -- inflate partition sizes or position numbers.
  ranked_pool as (
    select
      b.employee_id,
      b.location_id,
      b.client_id,
      rank() over (partition by b.location_id order by b.total_impact_score desc) as location_rank,
      rank() over (partition by b.client_id   order by b.total_impact_score desc) as client_rank,
      rank() over (                            order by b.total_impact_score desc) as platform_rank
    from base b
    where b.eligible and b.total_impact_score is not null
  ),
  loc_totals as (
    select location_id, count(*)::int as total
      from base where eligible and total_impact_score is not null
      group by location_id
  ),
  client_totals as (
    select client_id, count(*)::int as total
      from base where eligible and total_impact_score is not null
      group by client_id
  ),
  platform_total as (
    select count(*)::int as total
      from base where eligible and total_impact_score is not null
  )
  select
    b.employee_id,
    b.employee_name,
    b.location_id,
    b.location_name,
    b.client_id,
    b.client_name,
    b.active,
    b.total_impact_score,
    b.components_count,
    b.all_time_hours_worked,
    b.eligible,
    rp.location_rank::int                  as location_rank,
    coalesce(lt.total, 0)                  as location_total,
    rp.client_rank::int                    as client_rank,
    coalesce(ct.total, 0)                  as client_total,
    rp.platform_rank::int                  as platform_rank,
    coalesce(pt.total, 0)                  as platform_total
  from base b
  left join ranked_pool rp on rp.employee_id = b.employee_id
  left join loc_totals    lt on lt.location_id = b.location_id
  left join client_totals ct on ct.client_id   = b.client_id
  cross join platform_total pt;
$$;

-- ----------------------------------------------------------------------------
-- Backfill: compute TIS for every existing performance_records row using the
-- current weight config singleton. Single pass; downstream upserts via the
-- recompute pool will keep them in lockstep going forward.
-- ----------------------------------------------------------------------------
do $$
declare
  w_cs       numeric;
  w_att      numeric;
  w_on       numeric;
  w_tasks    numeric;
  w_survey   numeric;
begin
  select weight_cs_score, weight_attendance, weight_on_time, weight_tasks, weight_survey
    into w_cs, w_att, w_on, w_tasks, w_survey
    from public.total_impact_score_config
    limit 1;

  if w_cs is null then
    -- Shouldn't happen — mig 024 seeds the singleton — but stay defensive.
    w_cs := 0.4; w_att := 0.15; w_on := 0.15; w_tasks := 0.15; w_survey := 0.15;
  end if;

  -- Compute → JOIN → UPDATE. We can't reference the target table from a
  -- LATERAL subquery in UPDATE ... FROM, so collect (id, composite, count)
  -- in a CTE first and then JOIN back.
  with tis as (
    select
      pr.id,
      b.composite_score,
      b.components_count
    from public.performance_records pr,
    lateral public.compute_total_impact_score_breakdown(
      pr.customer_service_score,
      pr.attendance_pct,
      pr.on_time_grace_pct,
      pr.avg_task_list_completion_pct,
      pr.survey_engagement_pct,
      w_cs, w_att, w_on, w_tasks, w_survey
    ) b
  )
  update public.performance_records pr2
     set total_impact_score = t.composite_score,
         total_impact_score_components_count = t.components_count
    from tis t
   where t.id = pr2.id;
end $$;
