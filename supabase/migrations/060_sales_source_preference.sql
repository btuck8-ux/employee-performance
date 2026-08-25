-- ============================================================================
-- 060_sales_source_preference.sql — the Houston sales cutover, read side
-- (Houston-to-Toast spec 2026-08-25 §3, Tucker's ruling)
-- ============================================================================
-- WHY: Houston's ongoing sales source becomes Toast, because its 7shifts
-- pos_receipts mirror has dropped EVERY tip since 2026-05-31 — measured
-- 06-01 → 08-23: 7,700 HOU rows, $229,016 of sales, $0.00 of tips, while
-- every other store runs 4.79–6.94%. The damage is not cosmetic: with a
-- $0 tip numerator, tip_rate_pct / tip_per_hour / tip_rate_delta_pp come
-- out zero-or-null for EVERY Houston employee across Q2+Q3 2026, and those
-- three metrics feed total_impact_score — Houston's published rankings are
-- computed off a source that structurally cannot carry tips.
--
-- DESIGN — read-time preference, never deletion (spec §3): the cutover is
-- a PREFERENCE keyed on sales_records.source (mig 059: sevenshifts | toast
-- | legacy_pos | csv). For a Toast store on/after its OWN go-live, prefer
-- source='toast' and ignore the superseded 'sevenshifts' mirror rows.
-- legacy_pos rows still COUNT — the 04-30 → 05-04 overlap is COMPLEMENTARY,
-- not duplicate: legacy third-party delivery + Toast in-store sum to
-- Houston's real day (Tucker's ruling). Superseded rows are never deleted;
-- they are preferred away at read time and retire only on Tucker's explicit
-- word. One view — v_sales_effective — is THE single preference point;
-- every sales reader below re-points at it and changes nothing else.
--
-- ⚠️ DEPENDENCIES / APPLY ORDER: this migration requires 058
-- (v_location_flip_config + the function bodies re-emitted here are the
-- 058 versions) AND 059 (the sales_records.source column) to be applied
-- first. Apply order: 058 → 059 → 060, ALL with the flip PR — this
-- migration moves published Houston numbers the moment it applies.
--
-- ⚠️ OPERATOR WINDOW (documented, accepted): applying 058/059/060 BEFORE
-- the HOU Toast backfill lands means Houston's segment C (05-31 → present)
-- reads EMPTY — the sevenshifts rows are preferred away and no toast rows
-- exist yet to replace them. The sequence is: apply 058/059/060, then run
-- the HOU Toast backfill (the enablement in section 4 arms it — the
-- nightly orchestrator's first HOU run backfills from go-live), whose
-- recompute tail then lands the correct numbers. Do not stop midway.
--
-- ⚠️ FILE-ONLY until Cowork/Tucker applies via MCP (repo↔prod parity
-- pattern). NOT safe ahead of the flip PR's code — see apply order above.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) v_sales_effective — THE single sales-preference point.
--
-- Excludes ONLY superseded 7shifts mirror rows at Toast stores on/after each
-- store's OWN go-live; toast / legacy_pos / csv rows ALWAYS pass —
-- legacy_pos MUST count (the complementary 04-30 → 05-04 ruling: legacy
-- delivery + Toast in-store sum to the real day). Null-source rows pass:
-- they either predate a store's go-live or resist 059's classification —
-- an unclassified row is a FINDING (059's report query surfaces it), not
-- something to silently drop from every metric. The coalesce below is
-- load-bearing for that: a bare `s.source = 'sevenshifts'` is NULL for a
-- null-source row, and `not (NULL and …)` filters the row — exactly the
-- silent drop the design forbids.
--
-- transaction_at is store-local naive (016 convention) and
-- cfg.go_live::timestamp is local midnight of the go-live day — same clock,
-- no TZ math needed. Today only HOU has sevenshifts rows (pos_receipts was
-- Houston-only), so this predicate changes nothing at the other six stores.
--
-- security_invoker=true (028/037 convention): row visibility rides
-- sales_records' own RLS; v_location_flip_config is the 058 definer-rights
-- config view (three config columns, nothing row-sensitive).
-- ----------------------------------------------------------------------------
create or replace view public.v_sales_effective
with (security_invoker = true) as
select s.*
from public.sales_records s
join public.v_location_flip_config cfg
  on cfg.location_id = s.location_id
where not (
  coalesce(s.source = 'sevenshifts', false)
  and cfg.is_toast = true
  and cfg.go_live is not null
  and s.transaction_at >= cfg.go_live::timestamp
);

comment on view public.v_sales_effective is
  'THE single sales-preference point (mig 060, Houston-to-Toast spec 2026-08-25 §3): excludes only superseded 7shifts mirror rows at Toast stores on/after each store''s own go-live. toast/legacy_pos/csv always pass (legacy_pos MUST count — complementary 04-30→05-04 ruling); null-source rows pass (unclassified = a finding, never a silent drop). Superseded rows are preferred away, never deleted — retire only on Tucker''s word. Do not re-point sales readers at sales_records.';

-- ----------------------------------------------------------------------------
-- 2) v_sales_presence — re-emitted from 058 §3 with the sales source flipped
-- to v_sales_effective. Columns, semantics, and the "no $175 cap here" rule
-- are identical. Security posture unchanged: 016 created it WITHOUT
-- security_invoker and adding it now would change who can read through it —
-- deliberately left as-is (matching 058's re-emit).
--
-- (compute_cohort_daily_tip_rate (020) reads v_sales_presence only — the
-- preference covers it transitively; NOT re-emitted.)
-- ----------------------------------------------------------------------------
create or replace view public.v_sales_presence as
select
  s.id              as sale_id,
  s.location_id,
  s.transaction_at,
  s.tip_amount,
  s.total_amount,
  s.channel,
  s.order_type,
  s.is_refund,
  w.employee_id
from public.v_sales_effective s
join public.v_worked_intervals w
  on w.location_id = s.location_id
 and s.transaction_at >= w.shift_start
 and s.transaction_at <  w.shift_end;

-- ----------------------------------------------------------------------------
-- 3) compute_employee_tip_metrics — re-emitted from 058 §4. ONLY the two
-- sales reads change source (sales_records → v_sales_effective); the worked
-- side already reads v_worked_intervals (058). Every formula, the $175 cap,
-- clamps, null rules, and the signature are byte-identical.
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
    window_bounds as (
      select p_period_start::timestamp                       as window_start,
             (p_period_end + interval '1 day')::timestamp    as window_end
    ),
    -- Worked intervals at this location (source-switched per 058: the view
    -- carries the worked-entry filters and overnight clamp for both sources).
    worked as (
      select w.employee_id,
             w.shift_start,
             w.shift_end
      from public.v_worked_intervals w
      where w.location_id = p_location_id
        and w.entry_date >= p_period_start - interval '1 day'  -- include shifts that started day before
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
-- 4) recompute_team_tip_impact — re-emitted from 058 §5. ONLY the two sales
-- reads change source; the sweep-line, exact-set grouping, cap, baseline,
-- and delete-then-insert idempotency are byte-identical.
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

-- ----------------------------------------------------------------------------
-- 5) compute_employee_hourly_tip_rate — re-emitted from 058 §6. ONLY the
-- raw_sales read changes source; hour bucketing, the 10..20 slot, and all
-- aggregation are byte-identical (including 019's carried-over unused
-- window_bounds cross join in the shifts CTE).
-- ----------------------------------------------------------------------------
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
    -- Worked intervals at the location overlapping the window
    -- (source-switched per 058; the overnight-shift clamp lives in the view,
    -- so a 7pm-2am shift still includes its 12am-2am portion).
    shifts as (
      select w.employee_id,
             w.shift_start as s_raw,
             w.shift_end   as e_raw
        from public.v_worked_intervals w, window_bounds wb
       where w.location_id = p_location_id
         and w.entry_date >= p_start_date - interval '1 day'
         and w.entry_date <= p_end_date
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
        from public.v_sales_effective sr, window_bounds wb
       where sr.location_id = p_location_id
         and sr.transaction_at >= wb.window_start
         and sr.transaction_at <  wb.window_end
         and abs(sr.total_amount) < 175
         and extract(hour from sr.transaction_at) between 10 and 20
    ),
    -- Employee's sales: rung while THIS employee was on shift.
    -- DISTINCT ON guards against overlapping intervals duplicating a sale.
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

-- ----------------------------------------------------------------------------
-- 6) Houston enablement — guarded seed (the 042/056 idempotent pattern).
--
-- ⚠️ Mig 041's "never set toast_sales_enabled for HOU" rule is SUPERSEDED by
-- Tucker's 2026-08-25 ruling: Houston's ongoing sales source is Toast. The
-- double-source hazard 041 guarded against (7shifts pos_receipts + Toast
-- both landing HOU sales) is now handled by this migration's preference —
-- the sevenshifts rows are superseded at read, so both writers can coexist
-- without double-counting.
--
-- Enabling here means the nightly orchestrator's first HOU sales run
-- backfills from go-live (2026-04-30, mig 042's toast_sales_start_date)
-- into source='toast' — this IS the segment-C backfill mechanism; no
-- separate lever. The pos_receipts nightly keeps running for now (its rows
-- land superseded); retiring that writer is a later, explicit Tucker step.
-- ----------------------------------------------------------------------------
update public.locations
   set toast_sales_enabled = true,
       updated_at = now()
 where location_code = 'HOU'
   and toast_sales_enabled is distinct from true;
