-- ============================================================================
-- 055_toast_labor_feed.sql — Toast Labor worked-time feed (workstream I)
-- ============================================================================
-- Tucker's rulings, 2026-08-23 (Addendum 2 §2 + the crosswalk/identity
-- ruling): "7shifts = scheduled shift time. Toast = actual clock-in/out
-- time." The 7 Toast stores' punches never reach 7shifts (no integration,
-- and none will be configured), so EPD reads clock-in/out from Toast Labor
-- directly. Step-0 probe 2026-08-23 (probe-toast-labor-results doc):
-- Labor scope present; /labor/v1/timeEntries honours businessDate and
-- ≤30-day startDate/endDate windows; natural key is the time-entry guid.
--
-- ⚠️ IDENTITY ANCHOR (ruling §1a — do NOT "simplify" this later):
-- toast_employee_crosswalk maps toast_employee_guid → employees.id
-- DIRECTLY, never via seven_shifts_user_id. 7shifts is on a path to
-- removal (CP will own scheduling and pull punches from Toast); a
-- Toast↔EPD crosswalk survives that untouched, a Toast↔7shifts↔EPD chain
-- breaks. Any future refactor that routes this join through a 7shifts id
-- is reintroducing a dependency Tucker has ruled out.
--
-- ⚠️ THESE TABLES DELIBERATELY DO NOT WRITE OR REPLACE time_entries.
-- time_entries is UNIQUE (employee_id, entry_date, entry_type) and
-- sevenshifts/time.ts already upserts entry_type='worked' on that key —
-- a second worked-time writer would fight it nightly, last writer wins
-- (the H3 collision, one entry type over). The Toast feed lands in its
-- own per-punch table, runs in parallel, and reports the coverage delta;
-- switching time_entries / locations.actuals_source ('toast') is a
-- separate, evidenced decision AFTER tracing every actuals_source reader
-- (the 2026-07-27 audit: a naive flip "kills CO labor").
--
-- Crosswalk population (ruling §3/§4):
--  * match_method='email'            — deterministic Toast-login ↔ EPD email
--                                      equality; auto-committed.
--  * match_method='auto_behavioural' — punch-dates vs scheduled-days
--                                      agreement. Legitimate (schedule and
--                                      punch are measurements from
--                                      unconnected systems), but
--                                      auto-commits ONLY on an unambiguous
--                                      match (thresholds live in the
--                                      matcher + PR body); evidence stored
--                                      here; reversible from the SA surface.
--  * match_method='manual'           — SA-confirmed in the triage surface.
--  Name matching is FORBIDDEN as a match path (hint-only in the UI).
--  One EPD employee MAY hold several Toast guids (deleted/recreated Toast
--  accounts — /labor/v1/employees returns deleted staff too), hence guid
--  is the PK and employee_id is non-unique (cake_profile_crosswalk 031
--  precedent).
--
-- toast_time_entries stores EVERY punch at crosswalked restaurants
-- (locations.toast_restaurant_guid scoping — the credential also reaches
-- Chico CA and a stray second Fort Collins, which must never ingest;
-- unknown GUIDs are logged, never silently dropped). employee_id stays
-- nullable: punches from an unmatched Toast guid are stored unattributed —
-- they are the behavioural matcher's evidence and the triage queue's
-- signal — and are attributed when a crosswalk row lands. Keyed on the
-- Toast time-entry guid (per-punch, H3/054 per-shift precedent). deleted/
-- deleted_at mirror Toast's void marker.
--
-- RLS per 047 conventions: SA-only policies — the reading surfaces are the
-- SA crosswalk-triage and reconciliation views; the nightly writer rides
-- the service role (bypasses RLS by design).
--
-- Also widens the ingest_runs source CHECK for 'toast_labor' (039/049/054
-- drop-and-recreate pattern).
--
-- FILE-ONLY until Cowork/Tucker applies via MCP (repo↔prod parity
-- pattern). Purely additive; safe ahead of the code.
-- ============================================================================

create table public.toast_employee_crosswalk (
  toast_employee_guid text primary key,
  employee_id     uuid not null references public.employees(id) on delete cascade,
  location_id     uuid not null references public.locations(id),
  match_method    text not null check (match_method in ('email', 'auto_behavioural', 'manual')),
  -- Confidence evidence for auto matches (day-overlap counts, runner-up
  -- margin, window measured); null for email/manual rows.
  evidence        jsonb,
  -- SA identity for manual confirmations / undo audit; null for automatic rows.
  confirmed_by    uuid references public.users(id),
  confirmed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index toast_employee_crosswalk_employee_idx
  on public.toast_employee_crosswalk (employee_id);
create index toast_employee_crosswalk_location_idx
  on public.toast_employee_crosswalk (location_id);

comment on table public.toast_employee_crosswalk is
  'Toast employee guid → EPD employee (workstream I, 2026-08-23 ruling). Anchored on employees.id — NEVER via seven_shifts_user_id (§1a: 7shifts is on a removal path). match_method email|auto_behavioural|manual; name matching forbidden.';

alter table public.toast_employee_crosswalk enable row level security;

create policy toast_employee_crosswalk_sa_all on public.toast_employee_crosswalk
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create table public.toast_time_entries (
  toast_time_entry_guid text primary key,
  location_id       uuid not null references public.locations(id),
  toast_employee_guid text not null,
  -- Attributed via toast_employee_crosswalk at ingest time; null = punch
  -- from an unmatched Toast guid (triage-queue signal, matcher evidence).
  employee_id       uuid references public.employees(id),
  -- Toast businessDate — store-local by construction, comparable to
  -- time_entries.entry_date.
  entry_date        date not null,
  in_at             timestamptz not null,
  out_at            timestamptz,
  regular_hours     numeric,
  overtime_hours    numeric,
  job_reference_guid text,
  auto_clocked_out  boolean,
  -- Toast's void marker (deleted/deletedDate on the wire).
  deleted           boolean not null default false,
  deleted_at        timestamptz,
  raw               jsonb not null,
  last_seen_upstream_at timestamptz not null,
  ingested_at       timestamptz not null default now()
);

create index toast_time_entries_location_date_idx
  on public.toast_time_entries (location_id, entry_date);
create index toast_time_entries_employee_date_idx
  on public.toast_time_entries (employee_id, entry_date)
  where employee_id is not null;
create index toast_time_entries_toast_employee_idx
  on public.toast_time_entries (toast_employee_guid, entry_date);

comment on table public.toast_time_entries is
  'Direct Toast Labor punch mirror (workstream I, 2026-08-23). Per-punch, keyed on the Toast time-entry guid. Parallel to — never a writer of — time_entries; the worked-time switch (actuals_source=''toast'') is a separate evidenced decision.';

alter table public.toast_time_entries enable row level security;

create policy toast_time_entries_sa_all on public.toast_time_entries
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

-- ingest_runs source allow-list expansion (039/049/054 pattern).
alter table public.ingest_runs drop constraint if exists ingest_runs_source_check;
alter table public.ingest_runs add constraint ingest_runs_source_check check (source = any (array[
  '7shifts_time','7tasks','pos_receipts','cake_timesheets',
  'tattle','reviews','toast_sales','culture_pulse','toast_kitchen',
  'cp_schedule','7shifts_shifts','toast_labor']));
