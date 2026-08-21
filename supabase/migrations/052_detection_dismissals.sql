-- ============================================================================
-- 052_detection_dismissals.sql — operator dismissals for detected employees
-- ============================================================================
-- Triage sprint (kickoff-employee-triage-mint-ui-2026-08-21.md §3d). The
-- SA-only /dashboard/admin/employee-triage page lists CP's schedule-feed
-- detections (CP employee_directory, source='discovered_from_schedule') that
-- have no EPD employees row. "Not an employee / ignore" needs an EPD-side
-- memory for false detections (the "7shifts user 0" phantom class, one-off
-- schedule artifacts) WITHOUT minting a roster row — app_settings is
-- deliberately deny-all, so this tiny table is the §5-B pre-approved home.
--
-- Keyed on the 7shifts user id — the only cross-system identity triage
-- matching is allowed to use (never name). A row hides that detection from
-- the triage page; deleting the row un-dismisses (no UI lever yet, SQL only).
-- 0 is allowed: it's exactly the known phantom this table exists for.
--
-- RLS: SA-only for everything (047 conventions). The triage surface itself
-- is SA-only; no other tier ever reads or writes this table, and the app
-- writes ride the AUTHENTICATED client so these policies are load-bearing.
--
-- Apply via Cowork/Tucker MCP AFTER Codex review, BEFORE the triage PR
-- merges; this file is the parity copy (repo↔prod pattern). Safe to apply
-- ahead of the code: purely additive.
-- ============================================================================

create table public.detection_dismissals (
  seven_shifts_user_id bigint primary key
    check (seven_shifts_user_id >= 0),
  dismissed_at timestamptz not null default now(),
  dismissed_by uuid not null references auth.users(id)
);

comment on table public.detection_dismissals is
  'False schedule-feed detections dismissed on the SA triage page (2026-08-21 sprint). Keyed on the 7shifts user id (0 = the known phantom class); delete a row to un-dismiss.';

alter table public.detection_dismissals enable row level security;

create policy detection_dismissals_sa_all on public.detection_dismissals
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));
