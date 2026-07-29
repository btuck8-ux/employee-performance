-- ============================================================================
-- 043_kitchen_speed_hourly_residual.sql — Kitchen Speed v2: hourly residual
-- ============================================================================
-- Handoff 2026-07-29 (supersedes §6 of handoff-toast-kitchen-time-2026-07-28).
-- Two live findings killed the 7/28 design:
--   1. The role filter can't work: CO stores' restored role vocabulary
--      (CREW MEMBER / SHIFT LEAD / TEAM LEAD / GENERAL MANAGER / TRAINING) is
--      a scheduling hierarchy, not station assignments — no role selects
--      kitchen staff without also selecting register staff. Decision (Tucker
--      2026-07-29): drop role filtering entirely. Every employee on the clock
--      when a ticket fires gets it attributed; kitchen speed is a shared
--      shift outcome, not an individual skill.
--   2. A flat store-average baseline is unfair under (1): fulfillment time
--      varies ~3x by hour of day, so a flat baseline rewards whoever works
--      the 2pm lull and punishes whoever opens. Baseline is now per
--      (location, hour-of-day) and each employee scores on their mean
--      residual against it.
--
-- Constants (single source of truth — declared in each function below):
--   KITCHEN_WINDOW_START = '10:00'   Locked by Tucker 2026-07-29: score only
--   KITCHEN_WINDOW_END   = '20:00'   tickets fired 10:00:00–19:59:59 local
--     (end exclusive). Pre-10:00 is morning prep on an unattended KDS
--     (medians of 39–97 min — hour 8 median 5,828s, 89% over 15 min); 20:00+
--     is closing dribble (55 items total across all six stores).
--   KITCHEN_MAX_PREP_SECONDS = 1800  Tightened from 041's 7200: at 7200 the
--     residual mean stays hostage to a handful of 30–120 min bumps. 1800
--     excludes ~2.8% of items. Named so it can be tuned.
--   KITCHEN_MIN_CELL_ITEMS = 100     An (hour) cell with fewer items over the
--     period produces no baseline, and its items are excluded from scoring.
--     Every cell clears this comfortably today (smallest: LONGM 10am at 261)
--     — it protects new stores and short custom ranges.
--
-- The 15-shift reporting floor (KITCHEN_MIN_SHIFTS) is enforced app-side in
-- performance-recompute.ts / the PDF, not here: measured day-to-day residual
-- SD is 114s, so below ~15 shifts the number is noise.
--
-- Apply to prod via Supabase MCP; this file is the parity copy.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Hourly baseline: the store's own norm per hour of day.
-- ----------------------------------------------------------------------------
create or replace function public.kitchen_hourly_baseline(
  p_location_id uuid,
  p_start       date,
  p_end         date
) returns table (
  hour_of_day         smallint,
  items               integer,
  mean_prep_seconds   numeric,
  median_prep_seconds numeric
)
language plpgsql stable as $$
declare
  c_window_start   constant time    := time '10:00';  -- KITCHEN_WINDOW_START
  c_window_end     constant time    := time '20:00';  -- KITCHEN_WINDOW_END (exclusive)
  c_max_prep       constant integer := 1800;          -- KITCHEN_MAX_PREP_SECONDS
  c_min_cell_items constant integer := 100;           -- KITCHEN_MIN_CELL_ITEMS
begin
  return query
  select
    extract(hour from f.fired_local_time)::smallint,
    count(*)::integer,
    round(avg(f.prep_seconds), 1),
    (percentile_cont(0.5) within group (order by f.prep_seconds))::numeric
  from public.toast_item_fulfillments f
  where f.location_id = p_location_id
    and f.fired_local_date between p_start and p_end
    and f.fired_local_time >= c_window_start
    and f.fired_local_time <  c_window_end
    and f.prep_seconds between 1 and c_max_prep
  group by 1
  having count(*) >= c_min_cell_items
  order by 1;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Employee metric: mean residual vs the store's same-hour norm.
--
-- Attribution — NO role filter (see header). An item counts for an employee
-- iff a time_entries row exists with entry_type='worked', matching
-- location_id, entry_date = fired_local_date, and
-- in_time <= fired_local_time <= out_time. Deliberately NO worked_that_day
-- fallback (unchanged from 041).
--
-- Per item: residual_i = prep_seconds_i - baseline(location, hour_of(fired)).
-- residual_seconds = avg(residual_i); NEGATIVE = faster than the norm.
-- baseline_prep_seconds is the volume-weighted store baseline over the SAME
-- items, so residual_seconds = avg_prep_seconds - baseline_prep_seconds.
--
-- Interpretive limit (handoff §5a): the baseline is computed over the same
-- period as the employee, so the residual measures WITHIN-STORE RELATIVE
-- standing, not absolute improvement. Never describe it as "improvement" —
-- absolute quarter-over-quarter change belongs to
-- location_kitchen_avg_prep_seconds, not the per-employee row.
--
-- Return type changed from 041, so drop-then-create (create or replace
-- cannot change a result type).
-- ----------------------------------------------------------------------------
drop function if exists public.compute_kitchen_speed(uuid, uuid, date, date);

create function public.compute_kitchen_speed(
  p_employee_id uuid,
  p_location_id uuid,
  p_start       date,
  p_end         date
) returns table (
  items                 integer,
  tickets               integer,
  shifts                integer,   -- distinct fired_local_date they were on
  avg_prep_seconds      numeric,   -- their raw average
  baseline_prep_seconds numeric,   -- volume-weighted store baseline, same hours
  residual_seconds      numeric    -- avg_prep - baseline; NEGATIVE = faster
)
language plpgsql stable as $$
declare
  c_window_start   constant time    := time '10:00';  -- KITCHEN_WINDOW_START
  c_window_end     constant time    := time '20:00';  -- KITCHEN_WINDOW_END (exclusive)
  c_max_prep       constant integer := 1800;          -- KITCHEN_MAX_PREP_SECONDS
  c_min_cell_items constant integer := 100;           -- KITCHEN_MIN_CELL_ITEMS
begin
  return query
  with base as (
    -- Must apply the IDENTICAL window + cap as the attribution side below —
    -- a filter applied on one side only shows up as a large non-zero
    -- store-mean residual (handoff §7 check 2).
    select
      extract(hour from f.fired_local_time) as hod,
      avg(f.prep_seconds)                   as mean_prep
    from public.toast_item_fulfillments f
    where f.location_id = p_location_id
      and f.fired_local_date between p_start and p_end
      and f.fired_local_time >= c_window_start
      and f.fired_local_time <  c_window_end
      and f.prep_seconds between 1 and c_max_prep
    group by 1
    having count(*) >= c_min_cell_items
  ),
  attributed as (
    -- Inner join to base: items in an under-c_min_cell_items hour cell have
    -- no baseline and are excluded from scoring.
    select
      f.prep_seconds,
      f.ticket_guid,
      f.fired_local_date,
      b.mean_prep
    from public.toast_item_fulfillments f
    join base b on b.hod = extract(hour from f.fired_local_time)
    where f.location_id = p_location_id
      and f.fired_local_date between p_start and p_end
      and f.fired_local_time >= c_window_start
      and f.fired_local_time <  c_window_end
      and f.prep_seconds between 1 and c_max_prep
      and exists (
        select 1
        from public.time_entries te
        where te.employee_id = p_employee_id
          and te.location_id = f.location_id
          and te.entry_date  = f.fired_local_date
          and te.entry_type  = 'worked'
          and te.in_time  is not null
          and te.out_time is not null
          and te.in_time  <= f.fired_local_time
          and f.fired_local_time <= te.out_time
      )
  )
  select
    count(*)::integer,
    count(distinct a.ticket_guid)::integer,
    count(distinct a.fired_local_date)::integer,
    round(avg(a.prep_seconds), 1),
    round(avg(a.mean_prep), 1),
    round(avg(a.prep_seconds - a.mean_prep), 1)
  from attributed a;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Location aggregate: same service window + cap as the employee side, so
--    location_kitchen_avg_prep_seconds measures service (not pre-open KDS
--    attendance — FCOL aside, 8am store means run 3,800–6,600s) and stays
--    comparable to the per-employee raw average. This is the surface for
--    absolute quarter-over-quarter change (§5a).
-- ----------------------------------------------------------------------------
create or replace function public.compute_location_kitchen_speed(
  p_location_id uuid,
  p_start       date,
  p_end         date
) returns table (
  tickets          integer,
  items            integer,
  avg_prep_seconds numeric,
  med_prep_seconds numeric
)
language plpgsql stable as $$
declare
  c_window_start constant time    := time '10:00';  -- KITCHEN_WINDOW_START
  c_window_end   constant time    := time '20:00';  -- KITCHEN_WINDOW_END (exclusive)
  c_max_prep     constant integer := 1800;          -- KITCHEN_MAX_PREP_SECONDS
begin
  return query
  select
    count(distinct f.ticket_guid)::integer,
    count(*)::integer,
    round(avg(f.prep_seconds), 1),
    (percentile_cont(0.5) within group (order by f.prep_seconds))::numeric
  from public.toast_item_fulfillments f
  where f.location_id = p_location_id
    and f.fired_local_date between p_start and p_end
    and f.fired_local_time >= c_window_start
    and f.fired_local_time <  c_window_end
    and f.prep_seconds between 1 and c_max_prep;
end $$;

-- ----------------------------------------------------------------------------
-- 4. performance_records: v2 columns. kitchen_avg_prep_seconds and
--    location_kitchen_avg_prep_seconds keep their meaning;
--    kitchen_prep_delta_seconds is superseded by kitchen_residual_seconds
--    (hour-matched) — the old column stays but is no longer written.
-- ----------------------------------------------------------------------------
alter table public.performance_records
  add column if not exists kitchen_items            integer,
  add column if not exists kitchen_shifts           integer,
  add column if not exists kitchen_residual_seconds numeric;

comment on column public.performance_records.kitchen_residual_seconds is
  'avg prep minus the store''s same-hour baseline over the employee''s attributed items; negative = faster than norm. Null below the 15-shift floor. Supersedes kitchen_prep_delta_seconds (043).';
comment on column public.performance_records.kitchen_prep_delta_seconds is
  'Superseded by kitchen_residual_seconds as of 043 (flat-average delta, not hour-matched). No longer written.';

-- ----------------------------------------------------------------------------
-- 5. kitchen_role_config is deliberately unused as of 043 — the role filter
--    is gone (no CO role distinguishes kitchen from register staff). The
--    table stays in place because dropping it would need another migration
--    and it costs nothing.
-- ----------------------------------------------------------------------------
comment on table public.kitchen_role_config is
  'Deliberately unused as of 043: compute_kitchen_speed no longer role-filters (CO role vocabulary is a scheduling hierarchy, not stations). Kept to avoid a drop migration.';
