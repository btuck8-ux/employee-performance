-- RECOVERED 2026-09-04 from supabase_migrations.schema_migrations.statements
-- (applied to prod 2026-05-15, version 20260515171800, no file in the repo).
-- Byte-faithful to what was applied; this header is the only addition.
--
-- ⚠️ HISTORICAL. Migrations 058/060/066 have since rewritten this function
-- WITHOUT the two protections below (the 5-minute statement_timeout and the
-- indexed temp table), because this file did not exist for their authors to
-- carry forward. That regression is the confirmed cause of the FCCSU Q3
-- team-aggregation timeouts on 2026-09-03/04. Do NOT re-apply this file to
-- fix that — it would revert the flip, the sales-source preference and the
-- demarcation floor. Fix forward on top of 066.

-- Replace recompute_team_tip_impact with a join-driven version. The previous
-- implementation used a correlated `array(SELECT DISTINCT … ORDER BY …)`
-- subquery per interval, which Postgres can't decorrelate well; at busier
-- locations (Downtown Denver, Highlands Ranch — 40-50k POS rows) that pushed
-- past the statement timeout. The new version computes the active-set per
-- interval via a regular GROUP BY join over a materialized clipped-shifts
-- temp table, which gives the planner room to pick a hash/sort-merge plan.
--
-- Also raises the statement timeout for the function body to 5 minutes —
-- the heaviest legitimate run is still under that, but the default 60s lambda
-- timeout on Supabase free is not.
create or replace function public.recompute_team_tip_impact(
  p_location_id      uuid,
  p_report_period_id uuid
) returns int language plpgsql as $$
declare
  v_period_start date;
  v_period_end   date;
  v_window_start timestamp;
  v_window_end   timestamp;
  v_inserted     int;
begin
  -- Give the function room to run for the largest stores.
  set local statement_timeout = '5min';

  select period_start, period_end
    into v_period_start, v_period_end
    from public.report_periods
    where id = p_report_period_id;
  if v_period_start is null then
    return 0;
  end if;

  v_window_start := v_period_start::timestamp;
  v_window_end   := (v_period_end + interval '1 day')::timestamp;

  delete from public.team_tip_impact
    where location_id      = p_location_id
      and report_period_id = p_report_period_id;

  -- Materialize the clipped worked shifts to a temp table so we can index
  -- them — the planner does not generate index-friendly plans on a CTE.
  create temp table _clipped_shifts on commit drop as
  select te.employee_id,
         greatest(te.entry_date::timestamp + te.in_time, v_window_start) as s,
         least(
           case
             when te.out_time > te.in_time
               then te.entry_date::timestamp + te.out_time
             else (te.entry_date + interval '1 day')::timestamp + te.out_time
           end,
           v_window_end
         ) as e
    from public.time_entries te
   where te.location_id = p_location_id
     and te.entry_type  = 'worked'
     and te.entry_date >= v_period_start - interval '1 day'
     and te.entry_date <= v_period_end
     and te.in_time   is not null
     and te.out_time  is not null;
  delete from _clipped_shifts where e <= v_window_start or s >= v_window_end or e <= s;
  create index on _clipped_shifts (s);
  create index on _clipped_shifts (e);
  analyze _clipped_shifts;

  with
    boundaries as (
      select s as t from _clipped_shifts
      union
      select e as t from _clipped_shifts
    ),
    intervals as (
      select t                          as t_start,
             lead(t) over (order by t)  as t_end
        from boundaries
    ),
    -- One row per interval that has at least one active employee.
    -- INNER JOIN auto-excludes nobody-on-shift gaps.
    active_per_interval as (
      select i.t_start,
             i.t_end,
             array_agg(distinct c.employee_id order by c.employee_id) as members
        from intervals i
        join _clipped_shifts c
          on c.s <= i.t_start
         and c.e >  i.t_start
       where i.t_end is not null
         and i.t_end > i.t_start
       group by i.t_start, i.t_end
    ),
    interval_sales as (
      select a.t_start, a.t_end, a.members,
             coalesce(sum(sr.total_amount), 0) as sales,
             coalesce(sum(sr.tip_amount),   0) as tips
        from active_per_interval a
        left join public.sales_records sr
          on sr.location_id    = p_location_id
         and sr.transaction_at >= a.t_start
         and sr.transaction_at <  a.t_end
         and abs(sr.total_amount) < 175
       group by a.t_start, a.t_end, a.members
    ),
    teams as (
      select members,
             cardinality(members) as member_count,
             sum(extract(epoch from (t_end - t_start)) / 3600.0) as hours_together,
             sum(sales) as sales_during,
             sum(tips)  as tips_during
        from interval_sales
       group by members
    ),
    loc_baseline as (
      select coalesce(sum(sr.total_amount), 0) as sales,
             coalesce(sum(sr.tip_amount),   0) as tips
        from public.sales_records sr
       where sr.location_id = p_location_id
         and sr.transaction_at >= v_window_start
         and sr.transaction_at <  v_window_end
         and abs(sr.total_amount) < 175
         and exists (
           select 1 from _clipped_shifts c
            where sr.transaction_at >= c.s
              and sr.transaction_at <  c.e
         )
    )
  insert into public.team_tip_impact (
    location_id, report_period_id, member_ids, member_count,
    hours_together, sales_during, tips_during,
    tip_rate_pct, delta_vs_loc_pp
  )
  select
    p_location_id,
    p_report_period_id,
    t.members,
    t.member_count,
    t.hours_together,
    t.sales_during,
    t.tips_during,
    case when t.sales_during > 0
         then (t.tips_during / t.sales_during) * 100
    end as tip_rate_pct,
    case when t.sales_during > 0 and lb.sales > 0
         then (t.tips_during / t.sales_during
               - lb.tips / lb.sales) * 100
    end as delta_vs_loc_pp
  from teams t, loc_baseline lb;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;
