-- ============================================================================
-- 019_hourly_tip_rate.sql — Phase 7c: per-employee hourly tip-rate function
-- ============================================================================
-- Powers the new "Hourly tip rate" view on the employee page and the Teams
-- dashboard. Returns one row per hour-of-day (10..20 = 10am..8pm slot) with
-- the employee's tip rate at that hour and the matching location baseline.
--
-- Math conventions mirror compute_employee_tip_metrics (016):
--   * |total_amount| < $175 cap applies (catering / large-group excluded)
--   * Refunds carry signed values; sums net
--   * Location baseline is computed over sales rung during ANY worked shift
--     (same "covered by at least one shift" filter as 016 — so this hour's
--     loc tip rate is directly comparable to the quarterly tip badge).
--   * Hours covered: 10am-8pm slot (inclusive of 8pm hour = 8:00-8:59pm).
--     Service-period collapse is done client-side per Tucker's spec:
--       Lunch     = 10am-2pm (hours 10, 11, 12, 13)
--       Afternoon = 2pm-4pm  (hours 14, 15)
--       Dinner    = 4pm-9pm  (hours 16, 17, 18, 19, 20)
--
-- `employee_hours_worked` is the time the employee was clocked in during that
-- hour-of-day window summed across all dates in the range. A 10:30-1:30
-- shift contributes 0.5 to hour 10, 1.0 to hours 11 & 12, 0.5 to hour 13.
-- ============================================================================

create or replace function public.compute_employee_hourly_tip_rate(
  p_employee_id uuid,
  p_location_id uuid,
  p_start_date  date,
  p_end_date    date
) returns table (
  hour_of_day            int,
  employee_hours_worked  numeric,
  employee_sales         numeric,
  employee_tips          numeric,
  employee_tip_rate_pct  numeric,
  location_sales         numeric,
  location_tips          numeric,
  location_tip_rate_pct  numeric
) language sql stable as $$
  with
    window_bounds as (
      select p_start_date::timestamp                     as window_start,
             (p_end_date + interval '1 day')::timestamp  as window_end
    ),
    -- Worked shifts at the location overlapping the window. Overnight shifts
    -- have their out_time pushed to next-day (matches 016's convention so a
    -- 7pm-2am shift includes its 12am-2am portion at the appropriate hour).
    shifts as (
      select te.employee_id,
             (te.entry_date::timestamp + te.in_time) as s_raw,
             case when te.out_time > te.in_time
                  then te.entry_date::timestamp + te.out_time
                  else (te.entry_date + interval '1 day')::timestamp + te.out_time
             end as e_raw
        from public.time_entries te, window_bounds wb
       where te.location_id = p_location_id
         and te.entry_type  = 'worked'
         and te.entry_date >= p_start_date - interval '1 day'
         and te.entry_date <= p_end_date
         and te.in_time   is not null
         and te.out_time  is not null
    ),
    clipped as (
      select s.employee_id,
             greatest(s.s_raw, wb.window_start) as s,
             least(s.e_raw,    wb.window_end)   as e
        from shifts s, window_bounds wb
       where s.e_raw > wb.window_start
         and s.s_raw < wb.window_end
    ),
    -- Pull qualifying sales once, tag with hour-of-day. The 10..20 filter
    -- avoids loading off-peak rows we'll discard anyway.
    raw_sales as (
      select sr.id, sr.transaction_at,
             sr.total_amount, sr.tip_amount,
             extract(hour from sr.transaction_at)::int as hr
        from public.sales_records sr, window_bounds wb
       where sr.location_id = p_location_id
         and sr.transaction_at >= wb.window_start
         and sr.transaction_at <  wb.window_end
         and abs(sr.total_amount) < 175
         and extract(hour from sr.transaction_at) between 10 and 20
    ),
    -- Employee's sales: rung while THIS employee was on shift.
    -- DISTINCT ON guards against overlapping time_entries duplicating a sale.
    employee_sales_rows as (
      select distinct on (rs.id) rs.id, rs.hr, rs.total_amount, rs.tip_amount
        from raw_sales rs
        join clipped c
          on c.employee_id = p_employee_id
         and rs.transaction_at >= c.s
         and rs.transaction_at <  c.e
    ),
    -- Location sales: rung while ANY employee was on shift (= same filter
    -- 016 uses for its location baseline).
    loc_sales_rows as (
      select rs.id, rs.hr, rs.total_amount, rs.tip_amount
        from raw_sales rs
       where exists (
         select 1 from clipped c
          where rs.transaction_at >= c.s
            and rs.transaction_at <  c.e
       )
    ),
    -- Aggregate sales by hour.
    emp_agg as (
      select hr,
             sum(total_amount) as sales,
             sum(tip_amount)   as tips
        from employee_sales_rows
       group by hr
    ),
    loc_agg as (
      select hr,
             sum(total_amount) as sales,
             sum(tip_amount)   as tips
        from loc_sales_rows
       group by hr
    ),
    -- Employee hours-worked at each hour-of-day. Walk each hour bucket the
    -- shift touches via generate_series and accumulate the overlap duration.
    -- Filtered to 10..20 since off-peak hours are dropped from both views.
    employee_hours as (
      select extract(hour from h)::int as hr,
             sum(
               extract(epoch from (
                 least(c.e, h + interval '1 hour') - greatest(c.s, h)
               )) / 3600.0
             ) as hours_worked
        from clipped c
        cross join lateral generate_series(
          date_trunc('hour', c.s),
          date_trunc('hour', c.e - interval '1 microsecond'),
          interval '1 hour'
        ) h
       where c.employee_id = p_employee_id
         and extract(hour from h)::int between 10 and 20
       group by 1
    ),
    -- Driver row set: one row per service hour, even if the employee never
    -- worked that hour (so the chart x-axis stays gap-free).
    hours as (
      select generate_series(10, 20) as hr
    )
  select
    h.hr                                  as hour_of_day,
    coalesce(eh.hours_worked, 0)          as employee_hours_worked,
    coalesce(ea.sales, 0)                 as employee_sales,
    coalesce(ea.tips,  0)                 as employee_tips,
    case when ea.sales > 0
         then (ea.tips / ea.sales) * 100
    end                                   as employee_tip_rate_pct,
    coalesce(la.sales, 0)                 as location_sales,
    coalesce(la.tips,  0)                 as location_tips,
    case when la.sales > 0
         then (la.tips / la.sales) * 100
    end                                   as location_tip_rate_pct
  from hours h
  left join employee_hours eh on eh.hr = h.hr
  left join emp_agg        ea on ea.hr = h.hr
  left join loc_agg        la on la.hr = h.hr
  order by h.hr;
$$;
