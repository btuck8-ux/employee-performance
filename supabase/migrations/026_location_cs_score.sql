-- ============================================================================
-- 026_location_cs_score.sql — Location-Level CS Score Comparisons ("CS Trend")
-- ============================================================================
-- Rolls the per-employee Phase 9 Customer Service Score up to the location
-- level so managers can compare CS performance across quarters (time series)
-- and across locations within a chosen quarter (bar chart).
--
-- Aggregation:    hours-weighted average of eligible employees' CS Scores
--                 for the quarter, weighting by hours actually worked during
--                 that quarter at this location.
-- Eligibility:    employees.active = TRUE
--                 AND sum(all-time worked hours at this location) >= 40
--                 (mirrors Phase 10 TIS ranking eligibility — mig 025).
-- Null handling:  returns NULL composite when no eligible employee has both
--                 a non-null CS Score AND positive quarter hours.
--
-- Nothing is persisted — the location score derives entirely from inputs that
-- can change per upload, and a single CS Score recomputation could cascade
-- across every quarter. Computed on demand, mirroring `compute_tis_rankings_
-- for_quarter` from mig 025.
--
-- TypeScript helper at src/lib/location-cs-score.ts is the runtime / display
-- source of truth; the SQL functions below are what the UI calls (and what
-- you'd query directly to hand-reconcile).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- compute_location_cs_score
-- Single-value form. The hand-reconciliation target during dev / QA.
-- ----------------------------------------------------------------------------
create or replace function public.compute_location_cs_score(
  p_location_id      uuid,
  p_report_period_id uuid
) returns numeric
language sql stable as $$
  with rp as (
    select period_start, period_end
      from public.report_periods
     where id = p_report_period_id
  ),
  hours_all_time as (
    -- Tenure-proxy eligibility input: ALL-TIME worked hours at this location,
    -- not just the target quarter. Matches Phase 10's
    -- fetchAllTimeWorkedHours / compute_tis_rankings_for_quarter semantics.
    select
      te.employee_id,
      sum(
          coalesce(te.regular_hours,   0)
        + coalesce(te.ot_hours,        0)
        + coalesce(te.double_ot_hours, 0)
        + coalesce(te.holiday_hours,   0)
      ) as h
    from public.time_entries te
    where te.location_id = p_location_id
      and te.entry_type  = 'worked'
    group by te.employee_id
  ),
  hours_in_quarter as (
    -- Weight basis: hours actually worked at this location during the target
    -- quarter. An eligible employee who didn't punch in this quarter has
    -- weight zero and drops out of the weighted average (see filter below).
    select
      te.employee_id,
      sum(
          coalesce(te.regular_hours,   0)
        + coalesce(te.ot_hours,        0)
        + coalesce(te.double_ot_hours, 0)
        + coalesce(te.holiday_hours,   0)
      ) as h
    from public.time_entries te
    cross join rp
    where te.location_id = p_location_id
      and te.entry_type  = 'worked'
      and te.entry_date >= rp.period_start
      and te.entry_date <= rp.period_end
    group by te.employee_id
  ),
  eligible as (
    select e.id as employee_id
      from public.employees e
      left join hours_all_time hat on hat.employee_id = e.id
     where e.location_id = p_location_id
       and e.active = true
       and coalesce(hat.h, 0) >= 40
  ),
  scored as (
    select
      pr.employee_id,
      pr.customer_service_score      as cs_score,
      coalesce(hiq.h, 0)             as quarter_hours
    from public.performance_records pr
    join eligible            el  on el.employee_id  = pr.employee_id
    left join hours_in_quarter hiq on hiq.employee_id = pr.employee_id
    where pr.location_id      = p_location_id
      and pr.report_period_id = p_report_period_id
      and pr.customer_service_score is not null
  )
  select
    case
      when sum(quarter_hours) > 0 then sum(cs_score * quarter_hours) / sum(quarter_hours)
    end
    from scored
   where quarter_hours > 0;
$$;

-- ----------------------------------------------------------------------------
-- compute_location_cs_score_time_series
-- Returns the location's CS Score across every report_period it has any
-- performance_records for, chronologically ascending. Quarters with no data
-- are omitted (matches the page-level quarters union for this location).
--
-- One round-trip vs. N for the time-series chart.
-- ----------------------------------------------------------------------------
create or replace function public.compute_location_cs_score_time_series(
  p_location_id uuid
) returns table (
  report_period_id uuid,
  period_label     text,
  period_start     date,
  period_end       date,
  score            numeric
)
language sql stable as $$
  with periods as (
    select distinct rp.id, rp.label, rp.period_start, rp.period_end
      from public.report_periods rp
      join public.performance_records pr on pr.report_period_id = rp.id
     where pr.location_id = p_location_id
  )
  select
    p.id    as report_period_id,
    p.label as period_label,
    p.period_start,
    p.period_end,
    public.compute_location_cs_score(p_location_id, p.id) as score
  from periods p
  order by p.period_start asc;
$$;

-- ----------------------------------------------------------------------------
-- compute_location_cs_score_multi_location
-- Returns every location's CS Score at a given quarter, ranked by score desc
-- (NULLs last). Includes locations with no eligible / no-data state so the
-- bar chart explicitly shows "no data" rather than silently omitting peers.
-- ----------------------------------------------------------------------------
create or replace function public.compute_location_cs_score_multi_location(
  p_report_period_id uuid
) returns table (
  location_id   uuid,
  location_name text,
  score         numeric
)
language sql stable as $$
  select
    l.id   as location_id,
    l.name as location_name,
    public.compute_location_cs_score(l.id, p_report_period_id) as score
  from public.locations l
  where l.active = true
  order by public.compute_location_cs_score(l.id, p_report_period_id) desc nulls last,
           l.name asc;
$$;
