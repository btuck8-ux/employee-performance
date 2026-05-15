-- ============================================================================
-- 018_team_tip_impact.sql — Phase 7: co-presence team aggregates
-- ============================================================================
-- Materializes one row per (location, quarter, sorted-set-of-co-shifted-
-- employees) — the "team" unit Phase 7 visualizes.
--
-- A team is a unique set of employee IDs that were simultaneously clocked in
-- (entry_type='worked') at the same location during one or more overlapping
-- windows in a quarter. As people clock in and out the active set changes;
-- each distinct active set is a team. The same team can appear across many
-- non-contiguous windows over the quarter — they all aggregate together.
--
-- Math conventions match 016 exactly (so the leaderboard, scatter, and
-- heatmap stay consistent with the per-employee tip badge):
--   * Only |total| < $175 transactions enter the math (catering excluded).
--   * Refunds sum signed; tips are net.
--   * Location baseline is computed over sales rung during SOMEONE's shift
--     (mirrors `compute_employee_tip_metrics`).
--   * `delta_vs_loc_pp = team_tip_rate − location_tip_rate` in percentage
--     points.
--   * Hours_together = sum of (interval_end − interval_start) across every
--     window that team's exact membership was active.
--
-- The recomputer is idempotent: it DELETEs the (location, period) slice and
-- re-INSERTs from scratch. It's safe to call repeatedly from the POS upload
-- recompute path.
-- ============================================================================

create table public.team_tip_impact (
  id                 uuid primary key default uuid_generate_v4(),
  location_id        uuid not null references public.locations(id) on delete cascade,
  report_period_id   uuid not null references public.report_periods(id) on delete cascade,
  -- Sorted ascending UUID array; this is the natural key for a team.
  -- Sorted so the same membership set always produces the same array value
  -- regardless of clock-in order.
  member_ids         uuid[] not null,
  member_count       int    not null check (member_count = cardinality(member_ids)),
  hours_together     numeric not null,
  sales_during       numeric not null,           -- |total|<175 sales summed over co-presence windows (signed)
  tips_during        numeric not null,           -- |total|<175 tips summed   over co-presence windows (signed)
  tip_rate_pct       numeric,                    -- (tips/sales)*100; null when sales=0
  delta_vs_loc_pp    numeric,                    -- team_rate − location_rate (pp); null when baseline missing
  created_at         timestamptz not null default now(),
  unique (location_id, report_period_id, member_ids)
);

create index idx_team_impact_loc_period
  on public.team_tip_impact(location_id, report_period_id);
-- For "what teams was employee X part of?" reverse lookups.
create index idx_team_impact_members
  on public.team_tip_impact using gin (member_ids);

alter table public.team_tip_impact enable row level security;
create policy "team_tip_impact_authenticated_all"
  on public.team_tip_impact for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);

-- ----------------------------------------------------------------------------
-- recompute_team_tip_impact(location, report_period)
--
-- Sweep-line algorithm:
--   1. Collect every worked shift at the location overlapping the quarter,
--      with timestamps clipped to the quarter window.
--   2. Build the set of distinct event timestamps (every clock-in and every
--      clock-out boundary).
--   3. For each consecutive pair of timestamps form an interval; identify
--      the exact set of employees clocked in for that whole interval.
--   4. Pull sales rung during that interval (under cap), sum amounts and tips.
--   5. Group by the membership array, summing hours / sales / tips.
--   6. Compute location baseline using the same "covered by at least one
--      worked shift" filter as 016.
--   7. INSERT one row per distinct team.
--
-- Returns the count of teams inserted.
-- ----------------------------------------------------------------------------
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
  select period_start, period_end
    into v_period_start, v_period_end
    from public.report_periods
    where id = p_report_period_id;
  if v_period_start is null then
    return 0;
  end if;

  v_window_start := v_period_start::timestamp;
  v_window_end   := (v_period_end + interval '1 day')::timestamp;

  -- Idempotent re-run: blow away the slice, rebuild.
  delete from public.team_tip_impact
    where location_id      = p_location_id
      and report_period_id = p_report_period_id;

  with
    -- Worked shifts, with overnight-shift end clamped (same as 016).
    raw_shifts as (
      select te.employee_id,
             (te.entry_date::timestamp + te.in_time) as s_raw,
             case
               when te.out_time > te.in_time
                 then te.entry_date::timestamp + te.out_time
               else (te.entry_date + interval '1 day')::timestamp + te.out_time
             end as e_raw
      from public.time_entries te
      where te.location_id = p_location_id
        and te.entry_type  = 'worked'
        and te.entry_date >= v_period_start - interval '1 day'
        and te.entry_date <= v_period_end
        and te.in_time   is not null
        and te.out_time  is not null
    ),
    -- Clip to the quarter window and drop shifts that fall fully outside it.
    clipped as (
      select employee_id,
             greatest(s_raw, v_window_start) as s,
             least(e_raw,   v_window_end)   as e
      from raw_shifts
      where e_raw > v_window_start
        and s_raw < v_window_end
    ),
    -- Distinct event timestamps form the sweep line.
    boundaries as (
      select s as t from clipped
      union
      select e as t from clipped
    ),
    -- Consecutive boundary pairs become candidate intervals.
    intervals as (
      select t                                     as t_start,
             lead(t) over (order by t)             as t_end
      from boundaries
    ),
    -- For each interval, list who's clocked in (using half-open
    -- [s, e) semantics — end is exclusive, so a clock-out at t means
    -- that employee is NOT counted at interval starting at t).
    active_per_interval as (
      select i.t_start,
             i.t_end,
             array(
               select distinct c.employee_id
                 from clipped c
                where c.s <= i.t_start
                  and c.e >  i.t_start
                order by c.employee_id
             ) as members
      from intervals i
      where i.t_end is not null
        and i.t_end > i.t_start
    ),
    -- Sales within each interval (cap-filtered).
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
      where cardinality(a.members) > 0   -- discard nobody-on-shift windows
      group by a.t_start, a.t_end, a.members
    ),
    -- Roll up to one row per unique membership set.
    teams as (
      select members,
             cardinality(members) as member_count,
             sum(extract(epoch from (t_end - t_start)) / 3600.0) as hours_together,
             sum(sales) as sales_during,
             sum(tips)  as tips_during
      from interval_sales
      group by members
    ),
    -- Location baseline: sum capped sales rung while SOMEONE was on shift.
    -- This is the same denominator the per-employee tip badge uses, so
    -- delta_vs_loc_pp at the team level is directly comparable to the
    -- delta on the existing employee performance row.
    loc_baseline as (
      select coalesce(sum(sr.total_amount), 0) as sales,
             coalesce(sum(sr.tip_amount),   0) as tips
      from public.sales_records sr
      where sr.location_id = p_location_id
        and sr.transaction_at >= v_window_start
        and sr.transaction_at <  v_window_end
        and abs(sr.total_amount) < 175
        and exists (
          select 1 from clipped c
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
