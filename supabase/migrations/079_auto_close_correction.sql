-- ============================================================================
-- 079_auto_close_correction.sql — unclosed punches default to the scheduled
-- end (denominator spec rev 2 §7a, Tucker 2026-08-26: "If there is an
-- unclosed punch, just default the 'clock out' to the 'schedule_out' time").
-- ============================================================================
-- THE MEASURED POPULATION is Toast's own auto-closes, not null-outs: 2 rows
-- carry out_at IS NULL (neither has a schedule — the rule cannot fire);
-- 113 rows are Toast auto-closes crediting 1,045.7 hours, closed at end of
-- business day rather than shift end (DTD: 19 punches averaging 16.4h).
-- 106 of the 113 have a scheduled end — the rule fires there; the 7
-- without one are left untouched and REPORTED.
--
-- ⛔ WHERE THE CORRECTED VALUE LIVES: on toast_time_entries — verified NO
-- triggers — and NEVER on time_entries, whose unconditional BEFORE UPDATE
-- trigger bumps the exact updated_at that mig 072's ghost guard reads (a
-- corrected ghost would read as a live shift and suppress a departure —
-- CP walked into this trap's twin today). The vendor's out_at is KEPT AS
-- RECEIVED: an upstream value is a claim, and overwriting it destroys the
-- ability to check the claim later. The annotation goes beside the row.
--
-- ONE HOME FOR THE RULE: apply_auto_close_corrections() is both the
-- one-time backfill (called below) and the ongoing pass (the labor ingest
-- calls it after each punch upsert — the reconcileAttributions pattern).
-- Idempotent: only rows with corrected_out_at still NULL are touched, and
-- a human/operator clearing the column re-arms exactly that row.
--
-- ⚠️ This changes hours via v_worked_intervals (tip_rate_pct, tip_per_hour,
-- sales_during_presence). NOTHING here recomputes: scored values move only
-- in the single gated recompute pass after the before/after table is
-- reviewed (addendum §3).
-- ============================================================================

alter table public.toast_time_entries
  add column if not exists corrected_out_at timestamptz;

comment on column public.toast_time_entries.corrected_out_at is
  'Advisory corrected clock-out (spec rev 2 §7a): scheduled end applied to '
  'Toast auto-closes (and null-outs) — the vendor''s out_at is kept as '
  'received, this column sits beside it. Written ONLY by '
  'apply_auto_close_corrections(); consumed by v_worked_intervals via '
  'coalesce. This table has NO updated_at trigger — that is why the '
  'annotation may live here and never on time_entries (mig 072''s ghost '
  'guard reads time_entries.updated_at).';

create or replace function public.apply_auto_close_corrections()
returns table (corrected integer, skipped_no_schedule integer, skipped_nonpositive integer)
language plpgsql as $$
declare
  v_corrected int;
  v_no_sched  int;
  v_nonpos    int;
begin
  with candidates as (
    select tte.toast_time_entry_guid, tte.in_at, tte.location_id,
           tte.employee_id, tte.entry_date, l.timezone as tz
    from public.toast_time_entries tte
    join public.locations l on l.id = tte.location_id
    where tte.corrected_out_at is null
      and coalesce(tte.deleted, false) = false
      and tte.employee_id is not null
      and (tte.auto_clocked_out = true or tte.out_at is null)
  ),
  sched as (
    select c.toast_time_entry_guid, c.in_at,
      coalesce(
        -- Preferred: the live direct-feed shift end (timestamptz, exact).
        (select max(s.end_at)
           from public.seven_shifts_shifts s
           join public.employees e on e.id = c.employee_id
          where s.location_id = c.location_id
            and s.seven_shifts_user_id = e.seven_shifts_user_id
            and s.entry_date = c.entry_date
            and coalesce(s.deleted, false) = false
            and s.missing_upstream_since is null
            and s.end_at is not null),
        -- Fallback: the scheduled mirror row's local wall-clock end,
        -- projected at the store zone (overnight rule mirrors
        -- v_worked_intervals' out<=in convention).
        (select case
            when te.out_time > te.in_time
              then (c.entry_date::timestamp + te.out_time) at time zone c.tz
            else ((c.entry_date + 1)::timestamp + te.out_time) at time zone c.tz
          end
           from public.time_entries te
          where te.employee_id = c.employee_id
            and te.entry_date = c.entry_date
            and te.entry_type = 'scheduled'
            and te.out_time is not null
          limit 1)
      ) as sched_end
    from candidates c
  ),
  applied as (
    update public.toast_time_entries t
       set corrected_out_at = s.sched_end
      from sched s
     where t.toast_time_entry_guid = s.toast_time_entry_guid
       and s.sched_end is not null
       and s.sched_end > s.in_at   -- a scheduled end before clock-in is not a correction
    returning 1
  )
  select
    (select count(*) from applied),
    (select count(*) from sched where sched_end is null),
    (select count(*) from sched where sched_end is not null and sched_end <= in_at)
  into v_corrected, v_no_sched, v_nonpos;

  return query select v_corrected, v_no_sched, v_nonpos;
end $$;

comment on function public.apply_auto_close_corrections() is
  'Spec rev 2 §7a: stamps corrected_out_at (= scheduled end) on Toast '
  'auto-closed / never-closed punches that have a scheduled end for the '
  '(employee, date). Idempotent (NULL-guarded). Rows with no scheduled end '
  'or a nonpositive interval are left untouched and counted in the return '
  '— report them, never guess.';

revoke execute on function public.apply_auto_close_corrections()
  from public, anon, authenticated;
grant execute on function public.apply_auto_close_corrections() to service_role;

-- ── v_worked_intervals: the toast arm reads the corrected value ────────────
-- Re-emitted from 058 verbatim EXCEPT: shift_end coalesces corrected_out_at
-- first; hours derive from the CORRECTED interval when a correction exists
-- (the vendor's regular/overtime hours embed the auto-close inflation —
-- 19.6h "shifts" at a sandwich shop); the out_at filter admits corrected
-- never-closed rows. time_entries arm untouched.

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
  (coalesce(tte.corrected_out_at, tte.out_at) at time zone cfg.tz) as shift_end,
  case
    -- §7a: a corrected row's hours derive from the corrected interval —
    -- the vendor's hour fields embed the auto-close inflation.
    when tte.corrected_out_at is not null
      then extract(epoch from (tte.corrected_out_at - tte.in_at)) / 3600.0
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
  and coalesce(tte.corrected_out_at, tte.out_at) is not null;

comment on view public.v_worked_intervals is
  'Closed worked intervals in store-local naive time (addendum §3 flip, 2026-08-25; §7a corrected clock-outs, 2026-08-26 — coalesce(corrected_out_at, out_at), corrected rows derive hours from the corrected interval). Toast stores read toast_time_entries; NOLA/non-Toast read time_entries worked rows. THE single worked-time source for presence + hours derivations — do not re-point consumers at the base tables.';

-- One-time backfill: apply the rule to the measured population now. The
-- counts land in the migration log; expected ≈ 106 corrected / ≈7
-- no-schedule (reported, untouched) at apply time.
do $$
declare r record;
begin
  select * into r from public.apply_auto_close_corrections();
  raise notice 'auto-close correction: corrected=% skipped_no_schedule=% skipped_nonpositive=%',
    r.corrected, r.skipped_no_schedule, r.skipped_nonpositive;
end $$;
