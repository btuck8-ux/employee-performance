-- ============================================================================
-- 072_departure_notifier.sql — the sweep becomes a notifier (spec 2026-08-26
-- §6): find dormant rows → write candidates for operator review → a human
-- decides. "GOING FORWARD, the tombstone should act as a notifier" — Tucker.
-- ============================================================================
-- Tonight's 80 archives stand; this governs every run after them. There is
-- NO `update public.employees` anywhere in this path — deactivation is a
-- human act on the candidate-queue surface (§7c), never the sweep's.
--
-- The PERSON-LEVEL evidence clause is not a refinement: without it tonight's
-- sweep would have deactivated six actively-working multi-store people
-- (Meraz, Trevino, Hernandez, Beck, Sandifer, Cato). It lives IN the query,
-- not in a comment above it. Siblings correlate on seven_shifts_user_id
-- (217 of 218 rows carry one; the one exception falls back to its own row).
--
-- Tier gate: role_is_sweepable (mig 071) — user + manager sweep; area_admin
-- and above are immune until a human acts. A GM who stops working is a real
-- departure; a regional admin having no shifts is their normal state.
-- ============================================================================

create table if not exists public.departure_candidates (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references public.employees(id) on delete cascade,
  detected_at       timestamptz not null default now(),
  last_worked_at    date,
  last_scheduled_at date,
  days_dormant      integer not null,
  reason            text not null,
  status            text not null default 'open',   -- open | dismissed | actioned
  resolved_at       timestamptz,
  resolved_by       uuid references public.users(id)
);

comment on table public.departure_candidates is
  'Departure NOTIFIER queue (spec 2026-08-26 §6). The sweep writes candidates '
  'here; a human dismisses or deactivates on the §7c surface. The sweep never '
  'touches employees.active.';

-- The partial unique index is the point — re-running must not stack
-- duplicates. Re-running is a no-op on anyone already surfaced.
create unique index if not exists departure_candidates_open_uniq
  on public.departure_candidates (employee_id) where status = 'open';

alter table public.departure_candidates enable row level security;

-- SA-only surface (the §7c queue); the sweep's insert rides the service
-- role, which bypasses RLS (mig 047 write doctrine).
create policy departure_candidates_sa_all on public.departure_candidates
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

-- ── The sweep, every predicate inline ───────────────────────────────────────
-- Fresh evidence at ANY associated store clears a person entirely; a person
-- clears when ANY of four sources shows activity in the last 30 days:
--   worked:    time_entries (entry_type='worked'), toast_time_entries (live)
--   scheduled: time_entries (entry_type='scheduled'),
--              seven_shifts_shifts (live + still served upstream — a row the
--              vendor stopped serving proves nothing in either direction,
--              the §1g ghost doctrine; missing_upstream_since is the direct
--              feed's tombstone)
-- Returns the number of NEW candidates surfaced (conflicts with an already-
-- open candidate are no-ops via the partial index).

create or replace function public.sweep_departure_candidates()
returns integer
language sql
as $$
  with surfaced as (
    insert into public.departure_candidates
      (employee_id, last_worked_at, last_scheduled_at, days_dormant, reason)
    select
      e.id,
      lw.last_worked,
      ls.last_scheduled,
      (current_date - greatest(coalesce(lw.last_worked, date '1900-01-01'),
                               coalesce(ls.last_scheduled, date '1900-01-01')))::int,
      'no punch or schedule in 30 days at any associated store'
    from public.employees e
    left join lateral (
      select max(d) as last_worked from (
        select max(te.entry_date) as d
        from public.time_entries te
        join public.employees sib on sib.id = te.employee_id
        where te.entry_type = 'worked'
          and (sib.id = e.id
               or (e.seven_shifts_user_id is not null
                   and sib.seven_shifts_user_id = e.seven_shifts_user_id))
        union all
        select max(tt.entry_date)
        from public.toast_time_entries tt
        join public.employees sib on sib.id = tt.employee_id
        where coalesce(tt.deleted, false) = false
          and (sib.id = e.id
               or (e.seven_shifts_user_id is not null
                   and sib.seven_shifts_user_id = e.seven_shifts_user_id))
      ) w(d)
    ) lw on true
    left join lateral (
      select max(d) as last_scheduled from (
        select max(te.entry_date) as d
        from public.time_entries te
        join public.employees sib on sib.id = te.employee_id
        where te.entry_type = 'scheduled'
          and (sib.id = e.id
               or (e.seven_shifts_user_id is not null
                   and sib.seven_shifts_user_id = e.seven_shifts_user_id))
        union all
        select max(s.entry_date)
        from public.seven_shifts_shifts s
        where coalesce(s.deleted, false) = false
          and s.missing_upstream_since is null
          and (s.employee_id = e.id
               or (e.seven_shifts_user_id is not null
                   and s.seven_shifts_user_id = e.seven_shifts_user_id))
      ) sc(d)
    ) ls on true
    where e.active
      and public.role_is_sweepable(e.epd_role)                 -- tier gate
      and not exists (  -- PERSON-LEVEL: fresh direct-feed schedule anywhere
            select 1 from public.seven_shifts_shifts s
            where (s.employee_id = e.id
                   or (e.seven_shifts_user_id is not null
                       and s.seven_shifts_user_id = e.seven_shifts_user_id))
              and coalesce(s.deleted, false) = false
              and s.missing_upstream_since is null
              and s.entry_date > current_date - 30)
      and not exists (  -- PERSON-LEVEL: fresh worked mirror rows anywhere
            select 1 from public.time_entries te
            join public.employees sib on sib.id = te.employee_id
            where te.entry_type = 'worked'
              and (sib.id = e.id
                   or (e.seven_shifts_user_id is not null
                       and sib.seven_shifts_user_id = e.seven_shifts_user_id))
              and te.entry_date > current_date - 30)
      and not exists (  -- PERSON-LEVEL: fresh Toast punches anywhere
            select 1 from public.toast_time_entries tt
            join public.employees sib on sib.id = tt.employee_id
            where coalesce(tt.deleted, false) = false
              and (sib.id = e.id
                   or (e.seven_shifts_user_id is not null
                       and sib.seven_shifts_user_id = e.seven_shifts_user_id))
              and tt.entry_date > current_date - 30)
      and not exists (  -- PERSON-LEVEL: fresh scheduled mirror rows anywhere
            select 1 from public.time_entries te
            join public.employees sib on sib.id = te.employee_id
            where te.entry_type = 'scheduled'
              and (sib.id = e.id
                   or (e.seven_shifts_user_id is not null
                       and sib.seven_shifts_user_id = e.seven_shifts_user_id))
              and te.entry_date > current_date - 30
              -- §1g ghost doctrine (Codex should-fix, this sprint): a mirror
              -- row within the nightly's refresh reach (~14d back onward)
              -- counts as evidence only if the location's last successful
              -- cp_schedule run refreshed it — time_entries has no tombstone,
              -- so a ghost row would suppress a real departure forever
              -- (Josiah Ornelas's shape). Older rows are historical facts; a
              -- location with no successful run has no reference and its
              -- rows count (the departure-report GET's exact rule).
              and (te.entry_date < current_date - 14
                   or te.updated_at >= coalesce((
                        select max(ir.started_at)
                        from public.ingest_runs ir
                        where ir.location_id = sib.location_id
                          and ir.source = 'cp_schedule'
                          and ir.status = 'success'), timestamptz '-infinity')))
      and not exists (  -- a DISMISSAL STANDS until new activity starts a new
                        -- dormant stretch (Codex should-fix, this sprint):
                        -- without this, a dismissed person reinserts on every
                        -- run and the queue trains operators to ignore it.
                        -- New evidence after the dismissal re-arms the sweep.
            select 1 from public.departure_candidates dc
            where dc.employee_id = e.id
              and dc.status = 'dismissed'
              and dc.resolved_at >= greatest(
                    coalesce(lw.last_worked, date '1900-01-01'),
                    coalesce(ls.last_scheduled, date '1900-01-01'))::timestamptz)
    on conflict do nothing
    returning 1
  )
  select coalesce(count(*), 0)::int from surfaced;
$$;

comment on function public.sweep_departure_candidates() is
  'Departure NOTIFIER (spec 2026-08-26 §6): surfaces dormant sweepable people '
  'as open candidates for the §7c queue. Writes departure_candidates ONLY — '
  'never employees. Idempotent per person via departure_candidates_open_uniq.';

-- Operator lever only (POST /api/admin/departure-candidates rides the
-- service role); never callable by browsers.
revoke execute on function public.sweep_departure_candidates()
  from public, anon, authenticated;
grant execute on function public.sweep_departure_candidates() to service_role;
