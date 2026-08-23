-- ============================================================================
-- 053_detection_dismissals_per_location.sql — re-key dismissals on the pair
-- ============================================================================
-- Multi-location sprint (kickoff-multilocation-users-metrics-CODE-2026-08-23
-- §4-A3). Mig 052 keyed detection_dismissals on seven_shifts_user_id ALONE,
-- so dismissing a detection for a person at HRANCH also dismissed them at
-- LONGM — the same location-blind defect class as the triage exclusion, one
-- table over. Triage identity is (seven_shifts_user_id, location_id): one
-- person working two sites is two roster rows by design (mig 030's partial
-- unique index says the same for employees), and dismissals must scope the
-- same way.
--
-- SAFETY OF DROP-AND-RECREATE: the table held 0 rows when this was written
-- (verified live 2026-08-23 — the dismiss UI shipped in PR #20 on 08-21 and
-- no operator dismissal has been recorded). Cowork/Tucker: re-verify
--   select count(*) from public.detection_dismissals;   -- must be 0
-- immediately before applying; a nonzero count means an operator dismissed
-- something since and this migration needs a data-carrying rewrite instead.
-- With 0 rows, drop-and-recreate inside the migration's transaction is clean
-- and loses nothing.
--
-- Kept verbatim from 052: the >= 0 check (the "7shifts user 0" phantom class
-- is exactly what this table exists for), the FK to auth.users(id), RLS
-- enabled with the single SA-only policy (047 conventions — the app's
-- dismiss write rides the AUTHENTICATED client, so the policy is
-- load-bearing).
--
-- Apply via Cowork/Tucker MCP AFTER Codex review, BEFORE the PR merges;
-- this file is the parity copy (repo↔prod pattern).
-- ============================================================================

drop table public.detection_dismissals;

create table public.detection_dismissals (
  seven_shifts_user_id bigint not null
    check (seven_shifts_user_id >= 0),
  location_id uuid not null references public.locations(id),
  dismissed_at timestamptz not null default now(),
  dismissed_by uuid not null references auth.users(id),
  primary key (seven_shifts_user_id, location_id)
);

comment on table public.detection_dismissals is
  'False schedule-feed detections dismissed on the SA triage page. Keyed on the (7shifts user id, location) pair since mig 053 (2026-08-23 multi-location sprint) — a dismissal hides that detection at that site only. 0 = the known phantom class; delete a row to un-dismiss.';

alter table public.detection_dismissals enable row level security;

create policy detection_dismissals_sa_all on public.detection_dismissals
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));
