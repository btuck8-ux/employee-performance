-- Phase B behavioral policy tests (kickoff-phase-b-rls-2026-08-10.md §5).
--
-- MECHANISM: the local Supabase stack is unavailable on the build machine
-- (no Docker/CLI), so this is the packet's stated fallback — a single
-- transaction, run against the prod schema AFTER migration 047 is applied,
-- ROLLED BACK at the end so nothing persists. Run via Supabase MCP
-- execute_sql or psql as postgres/service role, as ONE statement/script:
--
--   the script raises an exception on the FIRST failed assertion
--   (aborting + rolling back everything); if it reaches the end you'll see
--   'PHASE B POLICY TESTS: ALL PASSED' and the final ROLLBACK still undoes
--   every seeded row.
--
-- WHAT IT PROVES, per tier (all data synthetic, seeded in-transaction):
--   system_admin  : sees all 8 locations, both seeded employees, can write
--   regional CO   : sees exactly the 6 CO stores; zero HOU/NOLA rows; no writes
--   area_admin    : sees exactly its 2 assigned stores; no writes
--   manager HOU   : sees only HOU; no writes
--   user (linked) : sees only its own employee-grain rows; empty
--                   location-grain; reference tables readable; own report
--                   object visible in storage; no writes
--   user (unlinked): sees nothing anywhere
--   + SA-only surfaces (ingest_runs, configs, users) invisible to every
--     non-SA tier; app_settings deny-all to ALL authenticated incl. SA.
--
-- Write-denial semantics under RLS: INSERT fails loudly (42501); UPDATE and
-- DELETE silently affect 0 rows (the USING clause filters them out) — the
-- assertions below encode exactly that.

begin;

-- ── Seed (synthetic, rolled back) ───────────────────────────────────────────

do $seed$
declare
  v_loc_cpd uuid; v_loc_hou uuid; v_loc_cos uuid;
  v_client uuid;
  v_emp_cpd uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_emp_hou uuid := 'aaaaaaaa-0000-0000-0000-000000000002';
  v_period uuid;
begin
  select id into strict v_loc_cpd from public.locations where location_code = 'CPD';
  select id into strict v_loc_hou from public.locations where location_code = 'HOU';
  select id into strict v_loc_cos from public.locations where location_code = 'COS';
  select client_id into strict v_client from public.locations where location_code = 'CPD';
  select id into v_period from public.report_periods order by period_start desc limit 1;

  -- six synthetic auth users, one per tested tier
  insert into auth.users (id, email, aud, role, created_at, updated_at)
  values
    ('eeeeeeee-0000-0000-0000-000000000001', 'epd-test-sa@test.invalid',        'authenticated', 'authenticated', now(), now()),
    ('eeeeeeee-0000-0000-0000-000000000002', 'epd-test-ra-co@test.invalid',     'authenticated', 'authenticated', now(), now()),
    ('eeeeeeee-0000-0000-0000-000000000003', 'epd-test-aa@test.invalid',        'authenticated', 'authenticated', now(), now()),
    ('eeeeeeee-0000-0000-0000-000000000004', 'epd-test-mgr-hou@test.invalid',   'authenticated', 'authenticated', now(), now()),
    ('eeeeeeee-0000-0000-0000-000000000005', 'epd-test-user@test.invalid',      'authenticated', 'authenticated', now(), now()),
    ('eeeeeeee-0000-0000-0000-000000000006', 'epd-test-user-unlinked@test.invalid', 'authenticated', 'authenticated', now(), now());

  -- synthetic employees (one CO, one HOU — the HOU one is the linked user).
  -- Explicit employee_code: the column default consumes employee_code_seq,
  -- and sequences do NOT roll back — test codes keep the real ledger gapless.
  insert into public.employees (id, location_id, employee_name, active, employee_code)
  values (v_emp_cpd, v_loc_cpd, 'EPD Test CPD Employee', true, 'EMP-TEST-0001'),
         (v_emp_hou, v_loc_hou, 'EPD Test HOU Employee', true, 'EMP-TEST-0002');

  insert into public.user_roles (user_id, role, territory_id, location_ids, location_id, employee_id)
  values
    ('eeeeeeee-0000-0000-0000-000000000001', 'system_admin',   null, null, null, null),
    ('eeeeeeee-0000-0000-0000-000000000002', 'regional_admin',
       (select id from public.territories where key = 'colorado'), null, null, null),
    ('eeeeeeee-0000-0000-0000-000000000003', 'area_admin',     null, array[v_loc_cpd, v_loc_cos], null, null),
    ('eeeeeeee-0000-0000-0000-000000000004', 'manager',        null, null, v_loc_hou, null),
    ('eeeeeeee-0000-0000-0000-000000000005', 'user',           null, null, null, v_emp_hou),
    ('eeeeeeee-0000-0000-0000-000000000006', 'user',           null, null, null, null);

  -- employee-grain rows (incl. pay -> row-level pay visibility rides along)
  insert into public.time_entries (employee_id, location_id, entry_date, entry_type, regular_hours, total_pay)
  values (v_emp_cpd, v_loc_cpd, current_date, 'worked', 8, 120),
         (v_emp_hou, v_loc_hou, current_date, 'worked', 8, 130);

  -- location-grain rows
  insert into public.tasks (location_id, task_list_name, task_name, task_date, source)
  values (v_loc_cpd, 'EPD Test List', 'epd-test-task-cpd', current_date, 'ui'),
         (v_loc_hou, 'EPD Test List', 'epd-test-task-hou', current_date, 'ui');

  -- a report row + its storage object (metadata only; rolled back)
  insert into public.generated_reports (id, employee_id, location_id, report_period_id, storage_path, template_version)
  values ('bbbbbbbb-0000-0000-0000-000000000001', v_emp_hou, v_loc_hou, v_period,
          v_loc_hou || '/' || v_emp_hou || '/epd-test-report.pdf', 'test');
  insert into storage.objects (bucket_id, name)
  values ('reports', v_loc_hou || '/' || v_emp_hou || '/epd-test-report.pdf');

  -- expose seeded ids to the denial tests via transaction-local GUCs —
  -- readable under ANY role, so the inserts below never resolve a NULL
  -- location through an RLS-filtered subquery (that would trip the NOT NULL
  -- constraint, 23502, before RLS's 42501).
  perform set_config('epd.test.loc_cpd', v_loc_cpd::text, true);
end $seed$;

-- ── Assertion machinery ─────────────────────────────────────────────────────

create temp table _t_expect (
  tier text, q text, expected bigint
) on commit drop;
-- the assertion loop reads this table AFTER switching to the authenticated
-- role; a postgres-owned temp table is not readable there without a grant.
grant select on _t_expect to authenticated;

-- per-tier visibility matrix: query text -> expected count.
-- Location counts are computed live (as postgres, before any role switch) so
-- the script never false-fails when the store roster changes.
insert into _t_expect values
  -- system_admin
  ('sa', 'select count(*) from public.locations',
         (select count(*) from public.locations)),
  ('sa', $q$select count(*) from public.employees where employee_name like 'EPD Test%'$q$, 2),
  ('sa', $q$select count(*) from public.tasks where task_name like 'epd-test-task-%'$q$, 2),
  ('sa', $q$select count(*) from storage.objects where name like '%epd-test-report.pdf'$q$, 1),
  ('sa', 'select count(distinct id) from public.customer_service_score_config', 1),
  ('sa', 'select (count(*) > 0)::int::bigint from public.ingest_runs', 1),
  ('sa', 'select count(*) from public.app_settings', 0),  -- deny-all incl. SA (deliberate)
  -- regional_admin colorado
  ('ra', 'select count(*) from public.locations',
         (select count(*) from public.locations l
          join public.territories t on t.id = l.territory_id
          where t.key = 'colorado')),
  ('ra', $q$select count(*) from public.locations l join public.territories t on t.id = l.territory_id where t.key <> 'colorado'$q$, 0),
  ('ra', $q$select count(*) from public.employees where employee_name like 'EPD Test%'$q$, 1),
  ('ra', $q$select count(*) from public.time_entries te where te.employee_id in ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002')$q$, 1),
  ('ra', $q$select coalesce(sum(te.total_pay), 0)::bigint from public.time_entries te where te.employee_id = 'aaaaaaaa-0000-0000-0000-000000000001'$q$, 120),  -- pay rides row-level (decision 2)
  ('ra', $q$select count(*) from public.tasks where task_name = 'epd-test-task-hou'$q$, 0),
  ('ra', $q$select count(*) from public.tasks where task_name = 'epd-test-task-cpd'$q$, 1),
  ('ra', 'select count(*) from public.ingest_runs', 0),
  ('ra', 'select count(*) from public.customer_service_score_config', 0),
  ('ra', 'select count(*) from public.users', 0),
  ('ra', 'select count(*) from public.user_roles', 1),   -- own row only
  ('ra', 'select (count(*) > 0)::int::bigint from public.report_periods', 1),
  ('ra', $q$select count(*) from storage.objects where name like '%epd-test-report.pdf'$q$, 0),
  -- area_admin (CPD + COS)
  ('aa', 'select count(*) from public.locations', 2),
  ('aa', $q$select count(*) from public.employees where employee_name like 'EPD Test%'$q$, 1),
  ('aa', $q$select count(*) from public.tasks where task_name like 'epd-test-task-%'$q$, 1),
  -- manager HOU
  ('mgr', 'select count(*) from public.locations', 1),
  ('mgr', $q$select count(*) from public.locations where location_code = 'HOU'$q$, 1),
  ('mgr', $q$select count(*) from public.employees where employee_name like 'EPD Test%'$q$, 1),
  ('mgr', $q$select count(*) from public.employees where employee_name = 'EPD Test CPD Employee'$q$, 0),
  ('mgr', $q$select count(*) from public.tasks where task_name = 'epd-test-task-hou'$q$, 1),
  ('mgr', $q$select count(*) from storage.objects where name like '%epd-test-report.pdf'$q$, 1),
  -- user, linked to the HOU test employee
  ('usr', $q$select count(*) from public.employees$q$, 1),
  ('usr', $q$select count(*) from public.employees where employee_name = 'EPD Test HOU Employee'$q$, 1),
  ('usr', $q$select count(*) from public.time_entries$q$, 1),
  ('usr', 'select count(*) from public.locations', 0),
  ('usr', $q$select count(*) from public.tasks$q$, 0),
  ('usr', 'select count(*) from public.sales_records', 0),
  ('usr', 'select count(*) from public.generated_reports', 1),
  ('usr', $q$select count(*) from storage.objects where name like '%epd-test-report.pdf'$q$, 1),
  ('usr', 'select (count(*) > 0)::int::bigint from public.report_periods', 1),
  ('usr', 'select count(*) from public.ingest_runs', 0),
  -- user, unlinked-pending: sees nothing
  ('usr0', 'select count(*) from public.employees', 0),
  ('usr0', 'select count(*) from public.time_entries', 0),
  ('usr0', 'select count(*) from public.generated_reports', 0),
  ('usr0', 'select count(*) from storage.objects', 0);

do $run$
declare
  tier record; exp record; got bigint;
  uid uuid;
  denied boolean;
begin
  for tier in
    select * from (values
      ('sa',   'eeeeeeee-0000-0000-0000-000000000001'::uuid),
      ('ra',   'eeeeeeee-0000-0000-0000-000000000002'::uuid),
      ('aa',   'eeeeeeee-0000-0000-0000-000000000003'::uuid),
      ('mgr',  'eeeeeeee-0000-0000-0000-000000000004'::uuid),
      ('usr',  'eeeeeeee-0000-0000-0000-000000000005'::uuid),
      ('usr0', 'eeeeeeee-0000-0000-0000-000000000006'::uuid)
    ) as t(name, uid)
  loop
    -- enter the tier's JWT context
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', tier.uid, 'role', 'authenticated')::text, true);

    -- visibility matrix
    for exp in select * from _t_expect e where e.tier = tier.name loop
      execute exp.q into got;
      if got is distinct from exp.expected then
        reset role;
        raise exception 'TIER % FAILED: [%] expected %, got %',
          tier.name, exp.q, exp.expected, got;
      end if;
    end loop;

    -- write denials for every non-SA tier:
    -- INSERT must raise 42501; UPDATE/DELETE must affect 0 rows.
    if tier.name <> 'sa' then
      denied := false;
      begin
        insert into public.tasks (location_id, task_list_name, task_name, task_date, source)
        values (current_setting('epd.test.loc_cpd')::uuid, 'x', 'epd-test-illegal', current_date, 'ui');
      exception when insufficient_privilege then denied := true;
      end;
      if not denied then
        reset role;
        raise exception 'TIER % FAILED: tasks INSERT was not denied', tier.name;
      end if;

      denied := false;
      begin
        insert into public.customer_service_score_config (weight_tattle, weight_reviews, weight_tip)
        values (0.4, 0.4, 0.2);
      exception when insufficient_privilege then denied := true;
      end;
      if not denied then
        reset role;
        raise exception 'TIER % FAILED: config INSERT was not denied', tier.name;
      end if;

      update public.employees set employee_name = employee_name || '!';
      if found then
        reset role;
        raise exception 'TIER % FAILED: employees UPDATE affected rows', tier.name;
      end if;

      delete from public.time_entries;
      if found then
        reset role;
        raise exception 'TIER % FAILED: time_entries DELETE affected rows', tier.name;
      end if;

      denied := false;
      begin
        insert into storage.objects (bucket_id, name) values ('uploads', 'epd-test-illegal.csv');
      exception when insufficient_privilege then denied := true;
      end;
      if not denied then
        reset role;
        raise exception 'TIER % FAILED: storage uploads INSERT was not denied', tier.name;
      end if;
    else
      -- SA write smoke: must succeed (then is rolled back with everything else)
      insert into public.tasks (location_id, task_list_name, task_name, task_date, source)
      values ((select id from public.locations where location_code = 'CPD'), 'EPD Test List', 'epd-test-sa-write', current_date, 'ui');
    end if;

    reset role;
  end loop;

  raise notice 'PHASE B POLICY TESTS: ALL PASSED';
end $run$;

rollback;
