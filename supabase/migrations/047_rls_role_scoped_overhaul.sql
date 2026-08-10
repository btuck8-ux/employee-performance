-- 047_rls_role_scoped_overhaul
-- Phase B of the RBAC sprint (kickoff-phase-b-rls-2026-08-10.md): drop every
-- permissive `authenticated` policy (26 ALL + 4 read-only, live-verified
-- 2026-08-10) and replace with role-scoped policies built on the 046
-- security-definer helpers; scope the three storage buckets; resolve the two
-- vestigial mig-001 tables; fix the two advisor nits.
--
-- Invariants:
--   * Service-role paths (crons, GH Actions, /api/scores, /api/identity,
--     /api/admin/*) BYPASS RLS — nothing here can affect them.
--   * Writes on EVERY table: system_admin only (locked decision 3).
--   * Reads per the Phase B classification table; deviations forced by the
--     live column shapes are listed in the PR body and flagged for Tucker.
--   * Performance: row-independent helper calls appear as scalar subselects
--     `(select public.helper())` so Postgres evaluates them once per
--     statement (InitPlan), never per row. Row-dependent predicates reduce
--     to array membership / uuid equality against those InitPlans.
--
-- Policy naming: <table>_read (FOR SELECT) + <table>_sa_write (FOR ALL).
-- Every table keeps an EXPLICIT select policy; no table's read model relies
-- on the FOR ALL write policy (its implicit select arm is redundant — the
-- read policies already pass for system_admin).

-- ── New helpers (extend the 046 canon; same style: security definer, stable,
--    pinned search_path, auth.uid()-bound, zero caller-supplied uid) ─────────

-- The calling session's own employee link. Non-null ONLY for user-tier rows
-- (the 046 scope-shape CHECK forces employee_id null on every other tier,
-- and the role filter keeps the 046 semantics explicit). Null = not user
-- tier, or user tier still unlinked-pending (sees nothing).
create or replace function public.epd_self_employee_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select employee_id from public.user_roles
  where user_id = auth.uid() and role = 'user';
$$;

-- Employee ids the calling session may read, as an array (computed once per
-- statement as an InitPlan; per-row cost in policies is array membership).
-- Definer privilege deliberately bypasses employees RLS — this IS the
-- visibility computation.
create or replace function public.epd_readable_employee_ids()
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(e.id), '{}')
  from public.employees e
  where e.location_id = any (coalesce(public.epd_authorized_location_ids(), '{}'))
     or e.id = public.epd_self_employee_id();
$$;

-- Re-express the 046 employee-grain predicate on the SAME primitives the 047
-- policies use, so route checks (src/lib/authz.ts) and policies can never
-- drift (TS↔SQL lockstep). Semantics are unchanged from 046: non-user tiers
-- match on the row's location; user tier matches only its linked employee
-- (epd_self_employee_id is null for every other tier by the scope CHECK).
create or replace function public.epd_can_read_employee(emp_id uuid, loc_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  -- outer coalesce: `emp_id = null-self-link` yields SQL null, and 046
  -- returned a hard false there — keep the contract boolean-total.
  select coalesce(
    loc_id = any (coalesce(public.epd_authorized_location_ids(), '{}'))
    or (emp_id is not null and emp_id = public.epd_self_employee_id()),
    false
  );
$$;

revoke execute on function public.epd_self_employee_id(),
                          public.epd_readable_employee_ids() from public, anon;
grant execute on function public.epd_self_employee_id(),
                          public.epd_readable_employee_ids()
  to authenticated, service_role;

-- ── Drop the permissive policies (26 ALL + 4 read) ──────────────────────────

drop policy clients_authenticated_all                       on public.clients;
drop policy customer_reviews_authenticated_all              on public.customer_reviews;
drop policy customer_service_score_config_authenticated_all on public.customer_service_score_config;
drop policy data_uploads_authenticated_all                  on public.data_uploads;
drop policy employees_authenticated_all                     on public.employees;
drop policy generated_reports_authenticated_all             on public.generated_reports;
drop policy locations_authenticated_all                     on public.locations;
drop policy metric_thresholds_authenticated_all             on public.metric_thresholds;
drop policy performance_records_authenticated_all           on public.performance_records;
drop policy report_generation_logs_authenticated_all        on public.report_generation_logs;
drop policy report_periods_authenticated_all                on public.report_periods;
drop policy review_attributions_authenticated_all           on public.review_attributions;
drop policy sales_records_authenticated_all                 on public.sales_records;
drop policy survey_assignments_authenticated_all            on public.survey_assignments;
drop policy surveys_authenticated_all                       on public.surveys;
drop policy task_accountability_authenticated_all           on public.task_accountability;
drop policy task_owners_authenticated_all                   on public.task_owners;
drop policy tasks_authenticated_all                         on public.tasks;
drop policy tattle_attributions_authenticated_all           on public.tattle_attributions;
drop policy tattle_responses_authenticated_all              on public.tattle_responses;
drop policy tattle_surveys_authenticated_all                on public.tattle_surveys;
drop policy team_tip_impact_authenticated_all               on public.team_tip_impact;
drop policy time_entries_authenticated_all                  on public.time_entries;
drop policy total_impact_score_config_authenticated_all     on public.total_impact_score_config;
drop policy user_location_access_authenticated_all          on public.user_location_access;
drop policy users_authenticated_all                         on public.users;
drop policy cake_profile_crosswalk_authenticated_read       on public.cake_profile_crosswalk;
drop policy ingest_runs_authenticated_read                  on public.ingest_runs;
drop policy kitchen_role_config_authenticated_read          on public.kitchen_role_config;
drop policy toast_item_fulfillments_authenticated_read      on public.toast_item_fulfillments;

-- ── Class 1: employee-grain, direct (row carries employee_id + location_id) ─
-- Non-user tiers scope on the ROW's location (history stays with the store
-- where it happened); user tier sees only its own linked employee's rows.
-- NOTE deviation from the packet table: time_entries HAS location_id live,
-- so it uses the direct form, not the employees join.

create policy performance_records_read on public.performance_records
  for select to authenticated
  using (
    location_id = any ((select public.epd_authorized_location_ids()))
    or employee_id = (select public.epd_self_employee_id())
  );
create policy performance_records_sa_write on public.performance_records
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy generated_reports_read on public.generated_reports
  for select to authenticated
  using (
    location_id = any ((select public.epd_authorized_location_ids()))
    or employee_id = (select public.epd_self_employee_id())
  );
create policy generated_reports_sa_write on public.generated_reports
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy time_entries_read on public.time_entries
  for select to authenticated
  using (
    location_id = any ((select public.epd_authorized_location_ids()))
    or employee_id = (select public.epd_self_employee_id())
  );
create policy time_entries_sa_write on public.time_entries
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy employees_read on public.employees
  for select to authenticated
  using (
    location_id = any ((select public.epd_authorized_location_ids()))
    or id = (select public.epd_self_employee_id())
  );
create policy employees_sa_write on public.employees
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

-- ── Class 2: employee-grain via array (row carries employee_id only) ────────
-- epd_readable_employee_ids() is one InitPlan; per-row work is membership.
-- NOTE deviation: task_owners is here (packet listed it location-grain, but
-- the live table has no location_id — same shape and treatment as
-- task_accountability).

create policy tattle_attributions_read on public.tattle_attributions
  for select to authenticated
  using (employee_id = any ((select public.epd_readable_employee_ids())));
create policy tattle_attributions_sa_write on public.tattle_attributions
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy review_attributions_read on public.review_attributions
  for select to authenticated
  using (employee_id = any ((select public.epd_readable_employee_ids())));
create policy review_attributions_sa_write on public.review_attributions
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy task_accountability_read on public.task_accountability
  for select to authenticated
  using (employee_id = any ((select public.epd_readable_employee_ids())));
create policy task_accountability_sa_write on public.task_accountability
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy task_owners_read on public.task_owners
  for select to authenticated
  using (employee_id = any ((select public.epd_readable_employee_ids())));
create policy task_owners_sa_write on public.task_owners
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy survey_assignments_read on public.survey_assignments
  for select to authenticated
  using (employee_id = any ((select public.epd_readable_employee_ids())));
create policy survey_assignments_sa_write on public.survey_assignments
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

-- ── Class 3: location-grain (row carries location_id) ───────────────────────
-- User tier's authorized array is empty → sees none of these (correct per
-- the role model — its metrics surface through the employee-grain tables).

create policy locations_read on public.locations
  for select to authenticated
  using (id = any ((select public.epd_authorized_location_ids())));
create policy locations_sa_write on public.locations
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy sales_records_read on public.sales_records
  for select to authenticated
  using (location_id = any ((select public.epd_authorized_location_ids())));
create policy sales_records_sa_write on public.sales_records
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy customer_reviews_read on public.customer_reviews
  for select to authenticated
  using (location_id = any ((select public.epd_authorized_location_ids())));
create policy customer_reviews_sa_write on public.customer_reviews
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy tattle_surveys_read on public.tattle_surveys
  for select to authenticated
  using (location_id = any ((select public.epd_authorized_location_ids())));
create policy tattle_surveys_sa_write on public.tattle_surveys
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy surveys_read on public.surveys
  for select to authenticated
  using (location_id = any ((select public.epd_authorized_location_ids())));
create policy surveys_sa_write on public.surveys
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy tasks_read on public.tasks
  for select to authenticated
  using (location_id = any ((select public.epd_authorized_location_ids())));
create policy tasks_sa_write on public.tasks
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy team_tip_impact_read on public.team_tip_impact
  for select to authenticated
  using (location_id = any ((select public.epd_authorized_location_ids())));
create policy team_tip_impact_sa_write on public.team_tip_impact
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy toast_item_fulfillments_read on public.toast_item_fulfillments
  for select to authenticated
  using (location_id = any ((select public.epd_authorized_location_ids())));
create policy toast_item_fulfillments_sa_write on public.toast_item_fulfillments
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

-- ── Class 4: location-grain via join ────────────────────────────────────────
-- NOTE deviation: tattle_responses has no location_id live — it reaches its
-- location through tattle_surveys. The inner array test is still an InitPlan.

create policy tattle_responses_read on public.tattle_responses
  for select to authenticated
  using (
    exists (
      select 1 from public.tattle_surveys ts
      where ts.id = tattle_survey_id
        and ts.location_id = any ((select public.epd_authorized_location_ids()))
    )
  );
create policy tattle_responses_sa_write on public.tattle_responses
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

-- ── Class 5: reference — readable by all signed-in (Tucker 8/10) ────────────

create policy report_periods_read on public.report_periods
  for select to authenticated using (true);
create policy report_periods_sa_write on public.report_periods
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy metric_thresholds_read on public.metric_thresholds
  for select to authenticated using (true);
create policy metric_thresholds_sa_write on public.metric_thresholds
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

-- ── Class 6: system_admin-only read (Tucker 8/10: clients, both scoring
--    configs, ops/health surfaces) ───────────────────────────────────────────
-- NOTE deviation: kitchen_role_config is here, not location-grain as the
-- packet table had it — the live table is a GLOBAL config (no location_id),
-- so it takes the locked config-class treatment. Flagged for ratification.
-- public.users also lands here (kept, not dropped — see vestigial section).

create policy clients_sa_read on public.clients
  for select to authenticated using ((select public.epd_is_system_admin()));
create policy clients_sa_write on public.clients
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy customer_service_score_config_sa_read on public.customer_service_score_config
  for select to authenticated using ((select public.epd_is_system_admin()));
create policy customer_service_score_config_sa_write on public.customer_service_score_config
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy total_impact_score_config_sa_read on public.total_impact_score_config
  for select to authenticated using ((select public.epd_is_system_admin()));
create policy total_impact_score_config_sa_write on public.total_impact_score_config
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy ingest_runs_sa_read on public.ingest_runs
  for select to authenticated using ((select public.epd_is_system_admin()));
create policy ingest_runs_sa_write on public.ingest_runs
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy data_uploads_sa_read on public.data_uploads
  for select to authenticated using ((select public.epd_is_system_admin()));
create policy data_uploads_sa_write on public.data_uploads
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy report_generation_logs_sa_read on public.report_generation_logs
  for select to authenticated using ((select public.epd_is_system_admin()));
create policy report_generation_logs_sa_write on public.report_generation_logs
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy cake_profile_crosswalk_sa_read on public.cake_profile_crosswalk
  for select to authenticated using ((select public.epd_is_system_admin()));
create policy cake_profile_crosswalk_sa_write on public.cake_profile_crosswalk
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy kitchen_role_config_sa_read on public.kitchen_role_config
  for select to authenticated using ((select public.epd_is_system_admin()));
create policy kitchen_role_config_sa_write on public.kitchen_role_config
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

create policy users_sa_read on public.users
  for select to authenticated using ((select public.epd_is_system_admin()));
create policy users_sa_write on public.users
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));

-- app_settings: RLS enabled with ZERO policies = deny-all to authenticated.
-- DELIBERATE (tokens live there; service-role only). Documented, not "fixed".

-- ── Storage: scope the three buckets ────────────────────────────────────────
-- Closes the Phase A Codex BLOCKER: direct Storage-API access from an
-- authenticated browser session now honors the same scoping as the report
-- route. Imports (uploads, csv-uploads) are SA-only end-to-end (decision 3).

drop policy csv_uploads_authenticated_select on storage.objects;
drop policy csv_uploads_authenticated_insert on storage.objects;
drop policy csv_uploads_authenticated_delete on storage.objects;
drop policy reports_authenticated_select     on storage.objects;
drop policy reports_authenticated_insert     on storage.objects;
drop policy reports_authenticated_update     on storage.objects;
drop policy reports_authenticated_delete     on storage.objects;
drop policy uploads_authenticated_select     on storage.objects;
drop policy uploads_authenticated_insert     on storage.objects;
drop policy uploads_authenticated_update     on storage.objects;
drop policy uploads_authenticated_delete     on storage.objects;

-- reports: select allowed when the object is a report the caller may read.
-- storage.objects.name = generated_reports.storage_path (verified: the
-- report actions upload with the exact string they persist to storage_path).
-- generated_reports RLS would scope the EXISTS anyway; the explicit helper
-- call keeps the predicate readable and lockstep with /api/reports/[id].
create policy reports_scoped_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'reports'
    and (
      (select public.epd_is_system_admin())
      or exists (
        select 1 from public.generated_reports gr
        where gr.storage_path = storage.objects.name
          and public.epd_can_read_employee(gr.employee_id, gr.location_id)
      )
    )
  );
create policy reports_sa_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'reports' and (select public.epd_is_system_admin()));
create policy reports_sa_update on storage.objects
  for update to authenticated
  using (bucket_id = 'reports' and (select public.epd_is_system_admin()))
  with check (bucket_id = 'reports' and (select public.epd_is_system_admin()));
create policy reports_sa_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'reports' and (select public.epd_is_system_admin()));

-- uploads + csv-uploads: SA-only on every command (imports are SA-only).
create policy uploads_sa_select on storage.objects
  for select to authenticated
  using (bucket_id = 'uploads' and (select public.epd_is_system_admin()));
create policy uploads_sa_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'uploads' and (select public.epd_is_system_admin()));
create policy uploads_sa_update on storage.objects
  for update to authenticated
  using (bucket_id = 'uploads' and (select public.epd_is_system_admin()))
  with check (bucket_id = 'uploads' and (select public.epd_is_system_admin()));
create policy uploads_sa_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'uploads' and (select public.epd_is_system_admin()));

create policy csv_uploads_sa_select on storage.objects
  for select to authenticated
  using (bucket_id = 'csv-uploads' and (select public.epd_is_system_admin()));
create policy csv_uploads_sa_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'csv-uploads' and (select public.epd_is_system_admin()));
create policy csv_uploads_sa_update on storage.objects
  for update to authenticated
  using (bucket_id = 'csv-uploads' and (select public.epd_is_system_admin()))
  with check (bucket_id = 'csv-uploads' and (select public.epd_is_system_admin()));
create policy csv_uploads_sa_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'csv-uploads' and (select public.epd_is_system_admin()));

-- ── Vestigial mig-001 tables (Tucker 8/10: investigate, drop if unused) ─────
--
-- public.user_location_access: DROPPED. Evidence: 0 rows live, no inbound
-- FKs, zero references anywhere in src/ (grep). Pre-RBAC concept fully
-- superseded by user_roles scope columns.
drop table public.user_location_access;

-- public.users: KEPT, SA-only (policies above). Evidence it is load-bearing:
-- 5 audit FKs point at it (data_uploads.uploaded_by,
-- performance_records.updated_by, generated_reports.generated_by,
-- report_generation_logs.triggered_by, and formerly user_location_access) and
-- the auth trigger below inserts into it on signup. Zero app code reads or
-- writes it. Its `role`/`can_upload` columns are pre-RBAC vestiges — the real
-- role model is user_roles (046); do not confuse the two.

-- Advisor nit #1: handle_new_auth_user (SECURITY DEFINER) was executable by
-- anon/authenticated. Trigger invocation does not require EXECUTE grants.
revoke execute on function public.handle_new_auth_user() from public, anon, authenticated;

-- Advisor nit #2: pin search_path on the 046 trigger function (matches the
-- helper style; plpgsql body only touches public + pg_catalog).
alter function public.user_roles_validate_location_ids() set search_path = public;
