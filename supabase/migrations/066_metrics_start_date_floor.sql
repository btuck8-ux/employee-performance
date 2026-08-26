-- 066: THE DEMARCATION FLOOR — data starts at Toast go-live, per store
-- (demarcation spec 2026-08-26 §1).
--
-- Tucker's ruling: "The date that Toast came on line for that location is
-- the DEMARCATION line for data." Mechanism: a FLOOR, not a delete —
-- nothing is destroyed. Two days of investigation (Q2 punch sprint,
-- 2026-08-25) established that the pre-Toast Colorado punches were never
-- recorded by anyone; the floor states that as a boundary instead of
-- laundering it into 385 absence verdicts.
--
-- WHAT THE FLOOR GATES: scoring and UI only — labor-derived metrics are
-- computed only from entry dates >= metrics_start_date. Days below the
-- floor are not absent, not zero, and not in any denominator — they are
-- outside the measured window, exactly as a future date is (the
-- scheduledScoredThrough cap's mirror at the other end).
--
-- WHAT IT DOES NOT GATE: /api/scores and every partner feed serve stored
-- history unchanged (§1d) — Training HQ holds value-only fingerprints on
-- the frozen quarters (Q3 2025 = 160 rows, Q4 2025 = 178), both entirely
-- below every store's floor; gating the feed would void that arrangement
-- overnight. Stored performance_records below the floor are left in place —
-- they simply stop being recomputed. No source row is deleted. Sales,
-- Tattle, surveys, tasks, reviews, kitchen: untouched. hire_date: retained.

-- ----------------------------------------------------------------------------
-- 1) The column. NULL means NO FLOOR — score everything — which is NOLA's
-- ruled behaviour (CAKE actuals; it never had the mapping defect). NULL must
-- NEVER be read as "floor at epoch" or "floor at today": a null that reads
-- as permissive-by-accident is the failure mode this project has hit four
-- times (the unmapped employee, the missing pagination object, the missing
-- coverage row, the absent shift row). Here null-is-permissive is the RULED
-- semantic, stated, not an accident.
-- ----------------------------------------------------------------------------
alter table public.locations
  add column if not exists metrics_start_date date;

comment on column public.locations.metrics_start_date is
  'Demarcation floor (2026-08-26 ruling): labor-derived metrics are computed '
  'only from entry dates >= this. NULL = no floor, score everything (NOLA — '
  'deliberate, ruled; never read null as epoch or today). Seeded from the '
  'store''s own Toast go-live; CSU inherits at onboarding once its row '
  'carries toast_sales_start_date. Gates scoring + UI only — NEVER the '
  'outbound feeds (§1d: THQ''s frozen-quarter fingerprints live below every '
  'floor).';

-- Seed: the store's own Toast go-live. NOLA (no Toast guid) stays null.
update public.locations
   set metrics_start_date = toast_sales_start_date
 where toast_restaurant_guid is not null
   and toast_sales_start_date is not null;

-- ----------------------------------------------------------------------------
-- 2) v_location_flip_config gains the floor as its FOURTH config column —
-- re-emitted from 058/061 with only that addition. Riding this view is what
-- lets the session-tier profile page resolve its own store's floor
-- (locations_read is purview-scoped and empty for the user tier — the 058
-- Codex blocker's lesson; same reason the view is definer-rights).
-- ----------------------------------------------------------------------------
create or replace view public.v_location_flip_config as
select
  l.id as location_id,
  (l.toast_restaurant_guid is not null) as is_toast,
  l.toast_sales_start_date              as go_live,
  l.timezone                            as tz,
  l.metrics_start_date                  as metrics_start
from public.locations l;

comment on view public.v_location_flip_config is
  'DELIBERATELY definer-rights (no security_invoker; expect the Supabase advisor to flag it): exposes only the flip''s per-store config (is-Toast, go-live, tz, metrics_start — the 066 demarcation floor) so v_worked_intervals'' split and the scoring floor work for every tier — locations_read is location-purview-scoped and empty for the user tier, which would otherwise drop self-only viewers'' own rows. Row-level protection lives on time_entries/toast_time_entries.';

-- ----------------------------------------------------------------------------
-- 3) compute_employee_tip_metrics — re-emitted from 060 with ONE delta: the
-- window start is clamped to the location's floor (greatest of the two).
-- Tip metrics are presence-derived — hours, sales-during-presence and tips
-- all ride worked intervals — so they are labor-derived and the floor
-- gates them. A window entirely below the floor yields an empty worked set
-- and the caller's existing no-data mapping nulls the block. Every formula,
-- the $175 cap, clamps, null rules, and the signature are byte-identical
-- to 060 otherwise.
-- ----------------------------------------------------------------------------
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
  location_sales_under_cap   numeric,  -- same math at the location level
  location_tips_under_cap    numeric,
  location_hours_worked      numeric,  -- total worked hours across all employees
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
    -- All sales at the location, in window, under the $175 abs cap, AND
    -- covered by at least one worked shift (this filters out sales rung in
    -- the gap between shifts, which shouldn't contribute to anyone's avg).
    location_capped_sales as (
      select s.id, s.total_amount, s.tip_amount
      from public.v_sales_effective s
      cross join window_bounds wb
      where s.location_id = p_location_id
        and s.transaction_at >= wb.window_start
        and s.transaction_at <  wb.window_end
        and abs(s.total_amount) < 175
        and exists (
          select 1 from worked w
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
      from worked w cross join window_bounds wb
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

-- ----------------------------------------------------------------------------
-- 4) recompute_team_tip_impact — floor delta only: v_window_start is clamped
-- to the location's floor (team tip impact is presence-derived, i.e. labor-
-- derived; leaving it unfloored would break the §1b rule for exactly one
-- metric). Sweep-line, exact-set grouping, cap, baseline, delete-then-insert
-- idempotency: byte-identical to 060.
-- ----------------------------------------------------------------------------
create or replace function public.recompute_team_tip_impact(
  p_location_id      uuid,
  p_report_period_id uuid
) returns int language plpgsql as $$
declare
  v_period_start date;
  v_period_end   date;
  v_floor        date;
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

  -- THE FLOOR (066): clamp the window start to the location's demarcation
  -- floor. Null floor = no clamp (NOLA).
  select metrics_start_date into v_floor
    from public.locations where id = p_location_id;
  if v_floor is not null and v_floor > v_period_start then
    v_period_start := v_floor;
  end if;

  v_window_start := v_period_start::timestamp;
  v_window_end   := (v_period_end + interval '1 day')::timestamp;

  -- Idempotent re-run: blow away the slice, rebuild.
  delete from public.team_tip_impact
    where location_id      = p_location_id
      and report_period_id = p_report_period_id;

  -- A window entirely below the floor rebuilds as empty — the delete above
  -- already cleared the slice, which is the floor's correct outcome.
  if v_window_start >= v_window_end then
    return 0;
  end if;

  with
    -- Worked intervals (source-switched per 058; overnight clamp and worked
    -- filters live in the view now).
    raw_shifts as (
      select w.employee_id,
             w.shift_start as s_raw,
             w.shift_end   as e_raw
      from public.v_worked_intervals w
      where w.location_id = p_location_id
        and w.entry_date >= v_period_start - interval '1 day'
        and w.entry_date <= v_period_end
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
      left join public.v_sales_effective sr
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
      from public.v_sales_effective sr
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
