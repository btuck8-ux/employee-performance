-- ============================================================================
-- 054_seven_shifts_shifts.sql — EPD's direct 7shifts scheduled-shift feed
-- ============================================================================
-- Multi-location sprint §4-H3 + the 2026-08-23 addendum (Tucker's ruling:
-- EPD owns its own metric inputs; CP keeps its artery for its scheduling
-- product). Per-shift storage keyed on the 7shifts shift id — strictly more
-- information than time_entries' one-row-per-employee-day collapse, and the
-- key that makes reassignment and deletion tractable.
--
-- ⚠️ THIS TABLE DELIBERATELY DOES NOT WRITE OR REPLACE time_entries.
-- time_entries is UNIQUE (employee_id, entry_date, entry_type) with FOUR
-- existing writers upserting on that key; a second schedule writer there
-- would collide with CP's schedule ingest nightly and whichever ran last
-- would silently win. Both feeds are retained in parallel for
-- cross-verification (§4-H5); the attendance denominator does NOT switch to
-- this table in the 2026-08 PR (§4-H6 — a separate, evidenced decision).
--
-- Discriminator columns are named from the §4-H2 probe (2026-08-23, all 3
-- companies): deleted / draft / open / publish_status are real payload
-- fields (deleted+draft read false on every returned row — deleted shifts
-- VANISH from the payload, so absence-tombstoning below is the delete
-- signal); attendance_status (none|late|no_show) and late_minutes are
-- 7shifts' own per-shift attendance call — the probe's headline discovery.
--
-- missing_upstream_since is the absence tombstone: set when a COMPLETE
-- window pull no longer returns the shift, cleared if it reappears. Never
-- set on a partial or failed pull (the ingest gates on pagination
-- completeness) — a flaky API must not read as mass cancellation.
--
-- Open/unassigned shifts (open=true, user_id 0/null) are filtered at read
-- time and never stored (addendum §4) — hence seven_shifts_user_id NOT
-- NULL. employee_id stays nullable: a real user id that matches no EPD
-- roster row at that site is stored unmatched and surfaced in run detail.
--
-- RLS per 047 conventions: SA-only policy — the only reading surfaces are
-- SA admin/reconciliation views; the nightly writer rides the service role
-- (bypasses RLS by design). Widen deliberately if a broader tier ever needs
-- it, don't default-open.
--
-- Also widens the ingest_runs source CHECK for '7shifts_shifts' (the
-- 039/049 drop-and-recreate pattern) — the nightly logs one run per store
-- under that source.
--
-- Apply via Cowork/Tucker MCP AFTER Codex review, BEFORE the PR merges;
-- file is the parity copy. Safe ahead of the code: purely additive.
-- ============================================================================

create table public.seven_shifts_shifts (
  seven_shifts_shift_id bigint primary key,
  location_id uuid not null references public.locations(id),
  employee_id uuid references public.employees(id),
  seven_shifts_user_id bigint not null,
  -- Store-local business date, derived with the same tz projection the
  -- worked-punch ingest uses (tz.ts) — comparable to time_entries.entry_date.
  entry_date date not null,
  start_at timestamptz not null,
  end_at timestamptz,
  role text,
  deleted boolean not null default false,
  draft boolean not null default false,
  publish_status text,
  attendance_status text,
  late_minutes integer,
  -- Absence tombstone: first complete pull that stopped returning this shift.
  missing_upstream_since timestamptz,
  last_seen_upstream_at timestamptz not null,
  raw jsonb not null,
  ingested_at timestamptz not null default now()
);

create index seven_shifts_shifts_location_date_idx
  on public.seven_shifts_shifts (location_id, entry_date);
create index seven_shifts_shifts_employee_date_idx
  on public.seven_shifts_shifts (employee_id, entry_date)
  where employee_id is not null;

comment on table public.seven_shifts_shifts is
  'Direct 7shifts scheduled-shift mirror (2026-08-23 sprint §4-H). Per-shift, keyed on the 7shifts shift id. Parallel to — never a writer of — time_entries; cross-verified against the CP-sourced scheduled rows. missing_upstream_since = absence tombstone (deleted shifts vanish from the payload).';

alter table public.seven_shifts_shifts enable row level security;

create policy seven_shifts_shifts_sa_all on public.seven_shifts_shifts
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

-- ingest_runs source allow-list expansion (039/049 pattern).
alter table public.ingest_runs drop constraint if exists ingest_runs_source_check;
alter table public.ingest_runs add constraint ingest_runs_source_check check (source = any (array[
  '7shifts_time','7tasks','pos_receipts','cake_timesheets',
  'tattle','reviews','toast_sales','culture_pulse','toast_kitchen',
  'cp_schedule','7shifts_shifts']));
