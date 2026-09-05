-- 094: recompute_team_tip_impact — materialize the clipped shift set and
-- compute the location baseline exactly once (MASTER sprint W3, staged
-- evidence 2026-09-05 on branch w3-fccsu-staging).
--
-- ⚠️ NOT YET APPLIED TO PRODUCTION. Application is a G4 gate (Tucker only).
--
-- ROOT CAUSE (measured, not assumed): in 066's single-statement form the
-- planner estimates the un-analyzed `clipped` CTE at 6 rows (actual 210 at
-- FCCSU), cascades that into estimating `teams` at 1 row, and therefore
-- plans the final `from teams t, loc_baseline lb` join as a nested loop
-- with the single-reference (hence inlined) loc_baseline aggregate on the
-- INNER side — re-executing the whole baseline aggregate once per team row.
-- FCCSU Q3: 179 teams x ~72ms/execution ≈ 13s of work against the 8s
-- deadline. The deadline that actually binds is the `authenticator` role's
-- statement_timeout=8s (PostgREST's login role); service_role carries no
-- override; the Vercel route's maxDuration=300 never gets a say.
--
-- WHY NOT A TIMEOUT BUMP: proven empirically on staging — a
-- `set local statement_timeout` executed INSIDE a running function does NOT
-- rescue the statement it is part of (the timer is armed at statement
-- start; a 3s-armed pg_sleep(5) died despite an in-function bump to 60s).
-- 018b's in-function bump was always a no-op for its own call; 018b worked
-- because of its temp-table rewrite. A timeout-only patch is therefore not
-- shippable on evidence, per the packet's ruling.
--
-- THE FIX, two structural changes, semantics of 066 preserved verbatim:
--   1. `clipped` becomes an indexed, ANALYZEd temp table (018b's pattern,
--      018c's drop-if-exists re-entry guard, NOT on commit drop) — the
--      planner sees real row counts.
--   2. The location baseline is computed ONCE into plpgsql variables in its
--      own statement — per-team re-execution becomes structurally
--      impossible regardless of any future estimate drift.
--
-- PRESERVED from 066 untouched: the metrics_start_date floor clamp; the
-- early `return 0` on an empty window (delete-then-return — a window fully
-- below the floor still clears its slice); v_worked_intervals and
-- v_sales_effective as the only data sources; half-open [s,e) membership
-- semantics; the $175 cap; delete-then-insert idempotency; every output
-- column and its arithmetic.
--
-- STAGED EVIDENCE (branch w3-fccsu-staging, object graph digest-identical
-- to prod, real copied fixture data at exact prod row counts):
--   FCCSU Q3  7,546ms → 176ms   (179 rows, byte-identical output)
--   DTD   Q3    636ms → 805ms   (422 rows, byte-identical; temp-table
--   COS   Q3    311ms → 428ms   (138 rows, byte-identical;  overhead)
--   under `set role service_role` + armed 8s timer: 066 body reproduces
--   prod's exact cancellation; this body completes.
--   Equivalence also held for: below-floor window (0 rows, early return),
--   null floor (NOLA), repeated calls in one transaction, midnight-crossing
--   shifts, and a synthetic duplicate+overlapping-shift fixture.

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
  v_base_sales   numeric;
  v_base_tips    numeric;
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

  -- Clipped shift set, materialized once (018b pattern; 018c re-entry
  -- guard — drop if exists, never on commit drop). ANALYZE is what fixes
  -- the 6-row estimate the whole failure cascaded from.
  drop table if exists tt_clipped;
  create temp table tt_clipped as
    select rs.employee_id,
           greatest(rs.s_raw, v_window_start) as s,
           least(rs.e_raw,   v_window_end)   as e
    from (
      select w.employee_id, w.shift_start as s_raw, w.shift_end as e_raw
      from public.v_worked_intervals w
      where w.location_id = p_location_id
        and w.entry_date >= v_period_start - interval '1 day'
        and w.entry_date <= v_period_end
    ) rs
    where rs.e_raw > v_window_start
      and rs.s_raw < v_window_end;
  create index on tt_clipped (s, e);
  analyze tt_clipped;

  -- Location baseline: sum capped sales rung while SOMEONE was on shift —
  -- same denominator as the per-employee tip badge (066). Computed ONCE
  -- into variables; the 8s failure was this aggregate re-executed per team
  -- row as the inner of a misestimated nested loop.
  select coalesce(sum(sr.total_amount), 0), coalesce(sum(sr.tip_amount), 0)
    into v_base_sales, v_base_tips
  from public.v_sales_effective sr
  where sr.location_id = p_location_id
    and sr.transaction_at >= v_window_start
    and sr.transaction_at <  v_window_end
    and abs(sr.total_amount) < 175
    and exists (
      select 1 from tt_clipped c
      where sr.transaction_at >= c.s
        and sr.transaction_at <  c.e
    );

  with
    -- Distinct event timestamps form the sweep line.
    boundaries as (
      select s as t from tt_clipped
      union
      select e as t from tt_clipped
    ),
    intervals as (
      select t                                     as t_start,
             lead(t) over (order by t)             as t_end
      from boundaries
    ),
    -- Who's clocked in per interval — half-open [s, e): a clock-out at t
    -- means NOT counted in the interval starting at t (066 semantics).
    active_per_interval as (
      select i.t_start,
             i.t_end,
             array(
               select distinct c.employee_id
                 from tt_clipped c
                where c.s <= i.t_start
                  and c.e >  i.t_start
                order by c.employee_id
             ) as members
      from intervals i
      where i.t_end is not null
        and i.t_end > i.t_start
    ),
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
      where cardinality(a.members) > 0
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
    case when t.sales_during > 0 and v_base_sales > 0
         then (t.tips_during / t.sales_during
               - v_base_tips / v_base_sales) * 100
    end as delta_vs_loc_pp
  from teams t;

  get diagnostics v_inserted = row_count;
  drop table if exists tt_clipped;
  return v_inserted;
end;
$$;

comment on function public.recompute_team_tip_impact(uuid, uuid) is
  'Team tip impact per (location, period). 094: clipped set materialized+analyzed, baseline computed once into variables — fixes the FCCSU 8s statement-timeout (plan pathology, not data volume). Semantics identical to 066.';
