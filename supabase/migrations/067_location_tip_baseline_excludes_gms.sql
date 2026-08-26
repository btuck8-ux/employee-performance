-- 067: GM exclusion for store-wide tip baselines (demarcation spec
-- 2026-08-26 §3, Tucker's ruling).
--
-- THE DEFECT: 276 rows Jan–Aug carry >16h on a single shift (signature:
-- clock-out one minute before clock-in — nobody clocked out and the shift
-- ran to the next punch), 4,173 phantom hours, 94% on GENERAL MANAGER /
-- Manager roles — salaried management nobody chases about a timesheet. EPD
-- ingests them faithfully; the corruption is upstream in 7shifts. Those
-- phantom intervals inflate location_hours and poison every store-wide
-- tip-per-hour baseline (and via presence-coverage, the store tip-rate
-- denominator).
--
-- THE RULING: exclude is_general_manager = true employees from the
-- STORE-WIDE side of the tip math — location hours, location tips/sales,
-- and the presence-coverage test that decides which sales enter the store
-- baseline. The EMPLOYEE side is untouched: a GM's own row still computes
-- from their own punches (the ruling explicitly accepts that a bad row
-- still lands on the GM's own record — the >16h flag, shipped TS-side in
-- the same packet, is what surfaces those). This supersedes mig 057's
-- "GM classification is never a metric input" for STORE-WIDE BASELINES
-- only; the per-employee metric paths still never read the flag
-- (gm-classification-contract pins them).
--
-- NOTE the ruling's known gap, accepted and mitigated elsewhere: Keeno
-- Suave is a Manager on an hourly wage (45 bad rows, 1,078 phantom hours)
-- whom a GM-only exclusion misses — the >16h flag exists for exactly that
-- class. Flag, never cap: a silent cap would hide an operational problem
-- the floor should fix.
--
-- Re-emitted from 066 (which carries the demarcation-floor clamp). Deltas
-- vs 066, and nothing else: worked_nongm CTE + the three location-side
-- reads switch to it.
create or replace function public.compute_employee_tip_metrics(
  p_employee_id uuid,
  p_location_id uuid,
  p_period_start date,
  p_period_end   date
) returns table (
  sales_under_cap            numeric,  -- sum total_amount over employee's presence, |total|<175, signed
  tips_under_cap             numeric,  -- sum tip_amount over employee's presence,   |total|<175, signed
  hours_worked               numeric,  -- employee's worked hours within window
  employee_tip_rate_pct      numeric,  -- tips / sales × 100, null if no qualifying sales
  employee_tip_per_hour      numeric,  -- tips / hours, null if no hours
  location_sales_under_cap   numeric,  -- same math at the location level (excl. GMs, 067)
  location_tips_under_cap    numeric,
  location_hours_worked      numeric,  -- total worked hours across non-GM employees (067)
  location_avg_tip_rate_pct  numeric,
  location_avg_tip_per_hour  numeric,
  tip_rate_delta_pp          numeric   -- (employee_tip_rate − location_tip_rate) in percentage points
) language sql stable as $$
  with
    -- THE FLOOR (066): the effective window start is the later of the
    -- requested start and the location's demarcation floor. Null floor =
    -- no clamp (NOLA). A fully-below-floor window makes window_start >
    -- window_end, every CTE empties, and the row comes back all-null/zero.
    floor_cfg as (
      select greatest(
               p_period_start,
               coalesce(l.metrics_start_date, p_period_start)
             ) as eff_start
      from public.locations l
      where l.id = p_location_id
    ),
    window_bounds as (
      select fc.eff_start::timestamp                         as window_start,
             (p_period_end + interval '1 day')::timestamp    as window_end
      from floor_cfg fc
    ),
    -- Worked intervals at this location (source-switched per 058: the view
    -- carries the worked-entry filters and overnight clamp for both sources).
    worked as (
      select w.employee_id,
             w.shift_start,
             w.shift_end
      from public.v_worked_intervals w
      cross join floor_cfg fc
      where w.location_id = p_location_id
        and w.entry_date >= fc.eff_start - interval '1 day'  -- include shifts that started day before
        and w.entry_date <= p_period_end
    ),
    -- GM EXCLUSION (067): the store-wide side reads only non-GM intervals.
    worked_nongm as (
      select w.*
      from worked w
      join public.employees e on e.id = w.employee_id
      where e.is_general_manager is distinct from true
    ),
    -- All sales at the location, in window, under the $175 abs cap, AND
    -- covered by at least one NON-GM worked shift (067: sales rung during
    -- GM-only presence stay out of the store baseline, exactly as sales
    -- rung between shifts always have).
    location_capped_sales as (
      select s.id, s.total_amount, s.tip_amount
      from public.v_sales_effective s
      cross join window_bounds wb
      where s.location_id = p_location_id
        and s.transaction_at >= wb.window_start
        and s.transaction_at <  wb.window_end
        and abs(s.total_amount) < 175
        and exists (
          select 1 from worked_nongm w
          where s.transaction_at >= w.shift_start
            and s.transaction_at <  w.shift_end
        )
    ),
    -- Sales that the target employee was present for. distinct on (id) so a
    -- sale isn't double-counted if an employee somehow has overlapping
    -- entries (shouldn't happen given the (employee_id,entry_date,entry_type)
    -- unique constraint, but defensive — and Toast punches CAN legitimately
    -- split a day into multiple rows, so the guard earns its keep now).
    employee_capped_sales as (
      select distinct on (s.id) s.id, s.total_amount, s.tip_amount
      from public.v_sales_effective s
      cross join window_bounds wb
      join worked w
        on w.employee_id = p_employee_id
       and s.transaction_at >= w.shift_start
       and s.transaction_at <  w.shift_end
      where s.location_id = p_location_id
        and s.transaction_at >= wb.window_start
        and s.transaction_at <  wb.window_end
        and abs(s.total_amount) < 175
    ),
    employee_hours_agg as (
      select coalesce(sum(
        extract(epoch from (
          least(w.shift_end, wb.window_end) - greatest(w.shift_start, wb.window_start)
        )) / 3600.0
      ), 0) as hours
      from worked w cross join window_bounds wb
      where w.employee_id = p_employee_id
        and w.shift_end   > wb.window_start
        and w.shift_start < wb.window_end
    ),
    location_hours_agg as (
      select coalesce(sum(
        extract(epoch from (
          least(w.shift_end, wb.window_end) - greatest(w.shift_start, wb.window_start)
        )) / 3600.0
      ), 0) as hours
      from worked_nongm w cross join window_bounds wb
      where w.shift_end   > wb.window_start
        and w.shift_start < wb.window_end
    ),
    emp_totals as (
      select coalesce(sum(total_amount), 0) as sales,
             coalesce(sum(tip_amount),   0) as tips
      from employee_capped_sales
    ),
    loc_totals as (
      select coalesce(sum(total_amount), 0) as sales,
             coalesce(sum(tip_amount),   0) as tips
      from location_capped_sales
    )
  select
    et.sales                                                              as sales_under_cap,
    et.tips                                                               as tips_under_cap,
    eh.hours                                                              as hours_worked,
    case when et.sales > 0 then (et.tips / et.sales) * 100 end            as employee_tip_rate_pct,
    case when eh.hours > 0 then  et.tips / eh.hours        end            as employee_tip_per_hour,
    lt.sales                                                              as location_sales_under_cap,
    lt.tips                                                               as location_tips_under_cap,
    lh.hours                                                              as location_hours_worked,
    case when lt.sales > 0 then (lt.tips / lt.sales) * 100 end            as location_avg_tip_rate_pct,
    case when lh.hours > 0 then  lt.tips / lh.hours        end            as location_avg_tip_per_hour,
    case
      when et.sales > 0 and lt.sales > 0
        then (et.tips / et.sales - lt.tips / lt.sales) * 100
    end                                                                   as tip_rate_delta_pp
  from emp_totals et,
       loc_totals lt,
       employee_hours_agg eh,
       location_hours_agg lh;
$$;
