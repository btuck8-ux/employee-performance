-- ============================================================================
-- 058_worked_intervals_flip.sql — the actuals flip, SQL side (addendum §3,
-- 2026-08-25): every "who was at work when" derivation moves to
-- v_worked_intervals
-- ============================================================================
-- WHY (addendum §3): the flip moves worked time from time_entries
-- (7shifts-sourced; proven to be missing punches) to toast_time_entries
-- (direct Toast punch mirror, mig 055) at the seven Toast stores. But worked
-- time isn't only the attendance input — it is ALSO the presence set behind
-- every tip/sales metric (016/018/019/020) and the worked-hours eligibility
-- behind TIS ranking and the location CS rollup (025/026). Measured evidence:
-- sales-attribution density at CPD decayed 305.8% → 204.0% Apr→Aug as the
-- missing punches shrank the "who was present" set — sales rung during real
-- shifts were falling out of everyone's numerator AND the location baseline.
-- If the flip switched attendance to Toast but left these SQL objects on
-- time_entries, tip metrics would keep reading the source the flip retires:
-- two truths in one report. So every SQL object that derives presence or
-- worked hours from time_entries worked rows switches sources HERE, in the
-- same PR as the flip.
--
-- HOW: one new view — v_worked_intervals — is THE single source-switch point.
-- It emits (location_id, employee_id, entry_date, shift_start, shift_end,
-- hours) as store-local naive timestamps + paid hours:
--   * Toast stores (locations.toast_restaurant_guid is not null, i.e. the
--     seven Toast stores incl. HOU), on/after each store's OWN go-live
--     (toast_sales_start_date): from toast_time_entries, projecting the
--     UTC instants onto the store-local clock via the new locations.timezone
--     column.
--   * non-Toast stores (toast_restaurant_guid is null — NOLA, whose actuals
--     ride CAKE into time_entries) AND every store's PRE-go-live history:
--     from time_entries worked rows, exactly as 016 built them. NOLA stays
--     on time_entries BY CONSTRUCTION — no per-store flag to forget — and
--     Houston's Feb–Apr (its Q2 straddles the 2026-04-30 go-live) keeps its
--     only source.
-- Every downstream function is re-emitted below with its worked-time CTE
-- pointed at the view; every scoring formula, the $175 cap, interval clamps,
-- null rules, and signatures are byte-identical to their prior definitions.
--
-- ⚠️ DELIBERATELY NOT REWIRED — KNOWN LIMITATION (accepted, addendum 2 §3):
-- compute_kitchen_speed (mig 043) matches kitchen staff on
-- time_entries.role, a 7shifts field Toast punches do not carry. Kitchen
-- Speed stays on time_entries. Closing it needs a maintained Toast
-- jobReference→role-name mapping (Toast's /labor/v1/jobs endpoint names
-- jobs per store) joined through toast_time_entries.job_reference_guid,
-- plus a kitchen_role_config equivalence review — a small feature, not a
-- blocker; the PDF is Kitchen Speed's only surface today.
--
-- ⚠️ FILE-ONLY until Cowork/Tucker applies via MCP (repo↔prod parity
-- pattern). Unlike 055/056 this is NOT safe ahead of the code: it moves
-- published tip numbers at the Toast stores the moment it is applied. It must
-- be applied WITH the flip PR, not before.
--
-- Objects NOT re-emitted (checked — they carry no direct time_entries worked
-- read, so the view flip covers them):
--   * compute_cohort_daily_tip_rate (020) — reads v_sales_presence only.
--   * compute_location_cs_score_time_series / _multi_location (026) —
--     delegate to compute_location_cs_score.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) locations.timezone — the SQL-side mirror of tz.ts LOCATION_TIMEZONES.
-- Needed because toast_time_entries stores absolute instants (timestamptz)
-- while sales_records.transaction_at and time_entries.in_time/out_time are
-- the store's LOCAL naive clock (016's TZ-free overlap convention). The view
-- below projects Toast's instants onto that same local clock per store.
-- Guarded seed (idempotent — the 042/056 pattern): re-applies are no-ops.
-- ----------------------------------------------------------------------------
alter table public.locations
  add column if not exists timezone text not null default 'America/Denver';

comment on column public.locations.timezone is
  'IANA zone, mirrors src/lib/ingest/sevenshifts/tz.ts LOCATION_TIMEZONES — TS↔SQL parity pinned by test. Used to project toast_time_entries'' UTC instants onto the store-local naive clock that sales_records.transaction_at and time_entries.in_time use (016 convention).';

update public.locations
   set timezone = 'America/Chicago'
 where location_code in ('HOU', 'NOLA')
   and timezone is distinct from 'America/Chicago';

-- ----------------------------------------------------------------------------
-- 2) v_worked_intervals — THE single source-switch point.
-- One row per closed worked interval, store-local naive timestamps on both
-- sides so the 016 overlap math stays TZ-free.
--
--   side (a) non-Toast stores, AND Toast stores BEFORE their go-live
--                              → time_entries   (016's exact construction)
--   side (b) Toast stores, on/after their go-live
--                              → toast_time_entries
--
-- ⚠️ THE SPLIT IS GO-LIVE-DATED, NOT ALL-OR-NOTHING PER STORE. Pre-go-live
-- worked history at Toast stores exists ONLY in time_entries — Houston went
-- live 2026-04-30, so its Q2 2026 straddles the boundary: April presence
-- lives in time_entries, May onward in toast_time_entries. An
-- all-or-nothing store split would silently erase every Toast store's
-- pre-Toast history from tips, hours, and eligibility (and HOU's Feb–Apr).
-- A GUID store with a NULL go-live keeps its time_entries history (the
-- `or cfg.go_live is null` branch below). ⚠️ LOAD-BEARING PAIR with §1's
-- loud-failure in the ingest loaders (labor.ts header carries the mirror
-- of this note): that failure guarantees no Toast rows can be ingested for
-- such a store, which is exactly why keeping the time_entries path here is
-- lossless. Neither behaviour is safe to remove without the other
-- (addendum 2, 2026-08-25 §3).
--
-- `hours`: paid-hours buckets, NOT interval spans — time_entries carries
-- regular/ot/double_ot/holiday and toast_time_entries carries
-- regular/overtime; both sides sum what the source says was paid, so the
-- ≥40h TIS eligibility and the CS quarter-weights keep their existing
-- semantics (a span would silently include unpaid breaks). Toast rows with
-- null hour buckets fall back to the interval span.
--
-- Side (b) exclusions, mirroring side (a)'s in/out-not-null requirement:
--   * out_at is null (open/unclosed punches) — excluded; a shift with no end
--     cannot bound a presence interval, same as (a) dropping null out_time.
--   * employee_id is null (unattributed punches) — these are the crosswalk
--     triage queue and the behavioural matcher's evidence (055), NOT worked
--     evidence; excluded until a crosswalk row attributes them.
--   * deleted = true — Toast's void marker; a voided punch never happened.
--
-- `timestamptz AT TIME ZONE l.timezone` yields timestamp-without-tz in that
-- zone — the same naive local clock as side (a). Because Toast stores
-- absolute instants, out is always after in on the timeline and the
-- overnight CASE side (a) needs is unnecessary on side (b).
--
-- entry_date: side (a) is time_entries.entry_date; side (b) is Toast's
-- businessDate (store-local by construction, 055) — both anchor an overnight
-- shift to its start-of-business day, so callers' entry_date window filters
-- behave identically across sides.
--
-- security_invoker=true (028/037 convention for new views): row visibility
-- comes from the SOURCE tables' RLS (time_entries / toast_time_entries both
-- carry the 047 Class-1 read: location purview OR self), so every tier sees
-- exactly the intervals it may see.
--
-- ⚠️ The store-config attributes (is-Toast / go-live / timezone) deliberately
-- come from v_location_flip_config below, a DEFINER-rights view, NOT a
-- direct locations join: locations_read grants only
-- epd_authorized_location_ids(), which is empty for the user tier — a
-- security_invoker join to locations would silently drop a user-tier
-- viewer's OWN intervals (Codex blocker, 2026-08-25). The config view
-- exposes three config columns and nothing else; row-level protection
-- stays with the source tables.
-- ----------------------------------------------------------------------------
create or replace view public.v_location_flip_config as
select
  l.id as location_id,
  (l.toast_restaurant_guid is not null) as is_toast,
  l.toast_sales_start_date              as go_live,
  l.timezone                            as tz
from public.locations l;

comment on view public.v_location_flip_config is
  'DELIBERATELY definer-rights (no security_invoker; expect the Supabase advisor to flag it): exposes only the flip''s per-store config (is-Toast, go-live, tz) so v_worked_intervals'' split works for every tier — locations_read is location-purview-scoped and empty for the user tier, which would otherwise drop self-only viewers'' own rows. Row-level protection lives on time_entries/toast_time_entries.';

create or replace view public.v_worked_intervals
with (security_invoker = true) as
select
  te.location_id,
  te.employee_id,
  te.entry_date,
  (te.entry_date::timestamp + te.in_time) as shift_start,
  case
    when te.out_time > te.in_time
      then te.entry_date::timestamp + te.out_time
    else (te.entry_date + interval '1 day')::timestamp + te.out_time
  end as shift_end,
  (coalesce(te.regular_hours,   0)
   + coalesce(te.ot_hours,        0)
   + coalesce(te.double_ot_hours, 0)
   + coalesce(te.holiday_hours,   0)) as hours
from public.time_entries te
join public.v_location_flip_config cfg
  on cfg.location_id = te.location_id
 and (cfg.is_toast = false
      -- A GUID store with no go-live yet keeps its time_entries history —
      -- the only source that can exist for it (§1's loud-failure stops the
      -- Toast ingest until the go-live is set); dropping the store entirely
      -- was the Codex blocker.
      or cfg.go_live is null
      or te.entry_date < cfg.go_live)
where te.entry_type = 'worked'
  and te.in_time  is not null
  and te.out_time is not null
union all
select
  tte.location_id,
  tte.employee_id,
  tte.entry_date,
  (tte.in_at  at time zone cfg.tz) as shift_start,
  (tte.out_at at time zone cfg.tz) as shift_end,
  case
    when tte.regular_hours is not null or tte.overtime_hours is not null
      then coalesce(tte.regular_hours, 0) + coalesce(tte.overtime_hours, 0)
    else extract(epoch from (tte.out_at - tte.in_at)) / 3600.0
  end as hours
from public.toast_time_entries tte
join public.v_location_flip_config cfg
  on cfg.location_id = tte.location_id
 and cfg.is_toast = true
 and cfg.go_live is not null
 and tte.entry_date >= cfg.go_live
where tte.deleted = false
  and tte.employee_id is not null
  and tte.out_at is not null;

comment on view public.v_worked_intervals is
  'Closed worked intervals in store-local naive time (addendum §3 flip, 2026-08-25). Toast stores (toast_restaurant_guid not null) read toast_time_entries; NOLA/non-Toast read time_entries worked rows. THE single worked-time source for presence + hours derivations — do not re-point consumers at the base tables.';

-- ----------------------------------------------------------------------------
-- 3) v_sales_presence — re-emitted from 016 with the join flipped to
-- v_worked_intervals. Columns, semantics, and the "no $175 cap here" rule are
-- identical to 016. Security posture unchanged: 016 created it WITHOUT
-- security_invoker and adding it now would change who can read through it —
-- deliberately left as-is.
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
from public.sales_records s
join public.v_worked_intervals w
  on w.location_id = s.location_id
 and s.transaction_at >= w.shift_start
 and s.transaction_at <  w.shift_end;

-- ----------------------------------------------------------------------------
-- 4) compute_employee_tip_metrics — re-emitted from 016. ONLY the `worked`
-- CTE changes source (time_entries → v_worked_intervals); the view already
-- applies the worked/in/out-not-null filters and the overnight clamp, so the
-- CTE keeps just the location + window filters. Everything else is
-- byte-identical to 016.
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
      from public.sales_records s
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
      from public.sales_records s
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
-- 5) recompute_team_tip_impact — re-emitted from 018. ONLY the `raw_shifts`
-- CTE changes source; the sweep-line, exact-set grouping, cap, baseline, and
-- delete-then-insert idempotency are byte-identical to 018.
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

-- ----------------------------------------------------------------------------
-- 6) compute_employee_hourly_tip_rate — re-emitted from 019. ONLY the
-- `shifts` CTE changes source (019's unused window_bounds cross join in that
-- CTE is carried over as-is to keep the body otherwise verbatim); hour
-- bucketing, the 10..20 slot, and all aggregation are byte-identical to 019.
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
        from public.sales_records sr, window_bounds wb
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
-- 7) compute_tis_rankings_for_quarter — re-emitted from 025. ONLY the
-- hours_by_emp CTE changes.
--
-- Hours keep 025's pay-bucket semantics: v_worked_intervals.hours sums the
-- source's paid-hour columns on both sides (time_entries' four buckets;
-- toast_time_entries' regular+overtime, span fallback only when both are
-- null), so the >= 40 eligibility gate measures the same thing it always
-- has and stays in lockstep with the TS-side fetchAllTimeWorkedHours.
-- Everything else is byte-identical to 025.
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
      w.employee_id,
      w.location_id,
      sum(w.hours) as hours_worked
    from public.v_worked_intervals w
    group by w.employee_id, w.location_id
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
-- 8) compute_location_cs_score — re-emitted from 026. ONLY hours_all_time and
-- hours_in_quarter change source; both sum v_worked_intervals.hours, which
-- keeps 026's pay-bucket semantics on every side (see the view header).
-- hours_all_time feeds the >= 40 eligibility gate; hours_in_quarter is the
-- weighted-average weight basis. Everything else is byte-identical to 026.
--
-- (compute_location_cs_score_time_series and _multi_location delegate here
-- and read no worked rows themselves — NOT re-emitted.)
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
      w.employee_id,
      sum(w.hours) as h
    from public.v_worked_intervals w
    where w.location_id = p_location_id
    group by w.employee_id
  ),
  hours_in_quarter as (
    -- Weight basis: hours actually worked at this location during the target
    -- quarter. An eligible employee who didn't punch in this quarter has
    -- weight zero and drops out of the weighted average (see filter below).
    select
      w.employee_id,
      sum(w.hours) as h
    from public.v_worked_intervals w
    cross join rp
    where w.location_id = p_location_id
      and w.entry_date >= rp.period_start
      and w.entry_date <= rp.period_end
    group by w.employee_id
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
-- 9) RLS: the two flip source tables move from SA-only reads to the
-- time_entries classification (047 Class 1, direct form: row-location
-- purview OR self).
--
-- ⚠️ WITHOUT THIS, METRICS BECOME VIEWER-DEPENDENT. v_worked_intervals is
-- security_invoker and the SQL functions above are invoker-rights; the
-- profile, rankings, and location surfaces run them through the SESSION
-- client. Under 054/055's SA-only read policies a manager's session would
-- read ZERO rows from toast_time_entries / seven_shifts_shifts — silently
-- computing 0 worked hours, empty presence, and an all-ineligible rankings
-- board at Toast stores for every non-SA viewer, while the SA sees real
-- numbers. Punch and schedule rows are exactly as sensitive as the
-- time_entries rows they replace, so they take exactly that policy.
-- Writes stay SA-only (the *_sa_all policies remain; ingest rides the
-- service role, which bypasses RLS).
-- ----------------------------------------------------------------------------
create policy toast_time_entries_read on public.toast_time_entries
  for select to authenticated
  using (
    location_id = any ((select public.epd_authorized_location_ids())::uuid[])
    or employee_id = (select public.epd_self_employee_id())
  );

create policy seven_shifts_shifts_read on public.seven_shifts_shifts
  for select to authenticated
  using (
    location_id = any ((select public.epd_authorized_location_ids())::uuid[])
    or employee_id = (select public.epd_self_employee_id())
  );

-- ----------------------------------------------------------------------------
-- 10) Column-level grants (addendum 2, 2026-08-25 §1 — Tucker's RLS ruling).
--
-- The Class-1 widening above is APPROVED: managers with location purview may
-- see wages/tips (they already can, via time_entries.wage and the POS), and
-- the employee tier is self-only BY POLICY SHAPE — epd_authorized_location_ids()
-- returns '{}' for the user tier, so the purview disjunct can never match and
-- only employee_id = epd_self_employee_id() remains. That isolation is the
-- one property here that must survive every future change (pinned by test).
--
-- RLS is row-level; the wage/tip exposure question is COLUMN-level:
-- toast_time_entries.raw carries the entire Toast payload (hourlyWage,
-- declaredCashTips, nonCashTips, tipsWithheld, cashSales, nonCashSales,
-- breaks, jobReference, employeeReference). Grant only what the view and
-- the SA surfaces consume — never raw. The ingest writes ride the service
-- role, whose grants are untouched.
--
-- seven_shifts_shifts gets the same narrowing by the same reasoning (its
-- raw jsonb is the full 7shifts payload; no session-client surface reads
-- it — judgement call recorded in PR #28). time_entries is deliberately
-- LEFT table-wide: it has no vendor blob, its wage column is exactly the
-- manager-visible exposure Tucker approved, and narrowing it would risk
-- breaking existing surfaces for zero exposure gain.
-- ----------------------------------------------------------------------------
revoke select on public.toast_time_entries from authenticated;
grant select (
  toast_time_entry_guid, location_id, toast_employee_guid, employee_id,
  entry_date, in_at, out_at, regular_hours, overtime_hours, deleted
) on public.toast_time_entries to authenticated;

revoke select on public.seven_shifts_shifts from authenticated;
grant select (
  seven_shifts_shift_id, location_id, employee_id, seven_shifts_user_id,
  entry_date, start_at, end_at, role, deleted, draft, publish_status,
  attendance_status, late_minutes, missing_upstream_since
) on public.seven_shifts_shifts to authenticated;
