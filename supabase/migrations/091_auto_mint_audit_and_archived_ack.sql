-- ============================================================================
-- 091_auto_mint_audit_and_archived_ack.sql — nightly auto-mint support
-- ============================================================================
-- Phase 3 of the 2026-08-31 identity packet. Three additive changes; no
-- existing row is touched and no existing behaviour changes until the
-- auto-mint job ships.
--
-- ⚠️ WHAT THIS DELIBERATELY DOES *NOT* ADD: a per-store identity unique
-- index. The packet asked for one, but
--   employees_location_seven_shifts_user_id_key
--   UNIQUE (location_id, seven_shifts_user_id) WHERE seven_shifts_user_id IS NOT NULL
-- has enforced exactly that since mig 030 (column order is irrelevant to
-- uniqueness). Session 2026-08-31 briefly added a duplicate as mig 088 and
-- dropped it again as mig 092. Do not re-add it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Admit 'auto_mint' as an ingest_runs source
-- ---------------------------------------------------------------------------
-- Same drop-and-recreate CHECK expansion as 032/036/038/039/041/049/055.
-- Purely additive to the allowed set, so it is safe to apply AHEAD of the
-- code — and it must be, or the job's startRun() fails the CHECK and the
-- nightly runs unlogged (the 2026-08-14 lesson in mig 049).
alter table public.ingest_runs drop constraint if exists ingest_runs_source_check;
alter table public.ingest_runs add constraint ingest_runs_source_check check (source = any (array[
  '7shifts_time','7tasks','pos_receipts','cake_timesheets',
  'tattle','reviews','toast_sales','culture_pulse','toast_kitchen',
  'cp_schedule','7shifts_shifts','toast_labor','auto_mint']));

-- ---------------------------------------------------------------------------
-- 2. employee_auto_mint_log — one row per automatically minted employee
-- ---------------------------------------------------------------------------
-- The packet's step 6: "log each auto-mint with the triggering CP row +
-- timestamp; surface the day's auto-mints in the digest for after-the-fact
-- review." This is the after-the-fact review trail for a write that happened
-- with no human in the loop, so it is written to be MORE durable than the row
-- it describes: employee_id goes null if the employee is ever removed, but
-- employee_code / 7shifts id / location / the triggering CP payload survive.
-- An audit log that cascades away with its subject is not an audit log.
create table if not exists public.employee_auto_mint_log (
  id uuid primary key default uuid_generate_v4(),
  -- Nullable ON PURPOSE — see above. Not a data-quality defect.
  employee_id uuid references public.employees(id) on delete set null,
  employee_code text not null,
  employee_name text not null,
  seven_shifts_user_id bigint not null check (seven_shifts_user_id > 0),
  location_id uuid not null references public.locations(id),
  cp_location_id uuid not null,
  email text,
  -- The CP employee_directory row that caused this mint, captured verbatim at
  -- decision time. CP has no delete path, but it DOES mutate rows in place
  -- (employee_code gets stamped), so a foreign key or a later re-read would
  -- not reproduce what the job actually saw.
  trigger_row jsonb not null,
  -- The ingest_runs row this mint belongs to; set null keeps the mint record
  -- if run history is ever pruned.
  run_id uuid references public.ingest_runs(id) on delete set null,
  minted_at timestamptz not null default now()
);

comment on table public.employee_auto_mint_log is
  'Audit trail for employees created by the nightly auto-mint job (no human in the loop). One row per mint, carrying the triggering CP employee_directory payload as seen at decision time. Deliberately survives deletion of the employee it describes.';
comment on column public.employee_auto_mint_log.trigger_row is
  'The CP employee_directory row verbatim at decision time. CP mutates rows in place (employee_code stamping), so this is NOT re-derivable by re-reading CP later.';

create index if not exists idx_auto_mint_log_minted_at
  on public.employee_auto_mint_log (minted_at desc);
create index if not exists idx_auto_mint_log_employee
  on public.employee_auto_mint_log (employee_id);

alter table public.employee_auto_mint_log enable row level security;

-- Read-only to system admins; the job writes via service_role, which bypasses
-- RLS. No update/delete policy at all — an audit row is not editable from the
-- app, by anyone.
create policy employee_auto_mint_log_sa_read on public.employee_auto_mint_log
  for select to authenticated
  using ((select public.epd_is_system_admin()));

-- ---------------------------------------------------------------------------
-- 3. identity_archived_schedule_ack — the archived-match dismissed state
-- ---------------------------------------------------------------------------
-- An "archived match" is a (7shifts user, location) pair that is STILL BEING
-- SCHEDULED in CP but whose EPD employee row is archived. The job must never
-- mint or auto-reactivate these — it reports them for human review.
--
-- Live count on 2026-08-31: ELEVEN, not one. Mostly the 2026-08-26 archive
-- cleanup meeting CP's no-delete-path schedule accumulation. Without a
-- dismissed state all eleven re-surface every night forever, which is how a
-- digest stops being read.
--
-- ⚠️ WHY THIS IS NOT detection_dismissals (mig 053), despite the identical
-- primary key: detection_dismissals means "this CP detection is not a real
-- person to mint", and the triage page's exclusion set is built from
-- employees ∪ detection_dismissals — with NO active filter, so an archived
-- pair is ALREADY excluded there as "minted". Writing these pairs into
-- detection_dismissals would therefore be a no-op for triage while
-- overloading that table with a second meaning. This table means something
-- different: "yes, this archived person is still on the schedule, we know,
-- stop telling us." Delete a row to make the pair report again.
create table if not exists public.identity_archived_schedule_ack (
  seven_shifts_user_id bigint not null check (seven_shifts_user_id > 0),
  location_id uuid not null references public.locations(id),
  -- Snapshot of who this was when acknowledged, so the row still reads
  -- sensibly if the employee is later reactivated, renamed, or removed.
  employee_code text,
  employee_name text,
  -- Free text: why this pair is expected to stay archived-but-scheduled.
  -- Required — an acknowledgement with no reason is indistinguishable from a
  -- misclick a quarter later.
  reason text not null check (length(btrim(reason)) > 0),
  acknowledged_by uuid not null references auth.users(id),
  acknowledged_at timestamptz not null default now(),
  primary key (seven_shifts_user_id, location_id)
);

comment on table public.identity_archived_schedule_ack is
  'Acknowledged archived-but-still-scheduled identity pairs. Suppresses a pair from the auto-mint digest''s human-review list; never affects minting (an archived pair is never mintable regardless). Delete a row to un-acknowledge. NOT the same thing as detection_dismissals — see mig 091.';

alter table public.identity_archived_schedule_ack enable row level security;

create policy identity_archived_schedule_ack_sa_all on public.identity_archived_schedule_ack
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

-- NOT SEEDED. The eleven live pairs are left unacknowledged on purpose so a
-- human triages them once, deliberately. In particular EMP-100181
-- ("Hollywould S", 7shifts 9054729, NOLA) is NOT pre-acknowledged here: the
-- 2026-08-31 ruling on that identity was "do nothing", and writing an ack row
-- would be doing something.
