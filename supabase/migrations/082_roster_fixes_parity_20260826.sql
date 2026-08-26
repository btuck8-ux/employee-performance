-- 082: repo↔prod parity for the 2026-08-26 evening roster/attribution fixes
-- (packet 5 §3 — queued mig; the established Cowork-applies/repo-commits
-- pattern). Prod ALREADY holds all of this — applying here is a no-op by
-- construction (on conflict do nothing / idempotent updates); on a fresh
-- database it reproduces the state. Evidence JSONs are VERBATIM from prod.
--
-- Contents:
--   §1 toast_non_human_guids — device / non-employee exclusions (3 rows).
--      An unattributed record with no recorded reason is indistinguishable
--      from one nobody has looked at; this table is the recorded reason.
--   §2 The Weesner remap + five manual CSU-era attributions (crosswalk
--      upserts, evidence verbatim). The Weesner evidence is ALSO the live
--      proof of the eligibility-filter defect: auto_behavioural committed
--      Garrison at 13/16 date containment with eligible_count=1 because
--      the TRUE owner (Weesner, 16/16) failed the 60-min ceiling — the
--      filter excludes exactly the chronically-late people whose punches
--      most need correct attribution (packet 4 §2 hypothesis, CONFIRMED).
--   §3 Garrison punches_time_clock = false on BOTH rows (FCCSU + FCOL) —
--      ruling 8: excluded from the attendance denominator, null never 0.
--   §4 RLS + revoke over EVERY RLS-less public table (Tucker, packet 6 §2:
--      "Keep and widen to all 22 — APPROVED"; already applied in prod,
--      2026-08-26 night — this is parity, not a proposal).

-- ── §1 toast_non_human_guids ───────────────────────────────────────────────

create table if not exists public.toast_non_human_guids (
  toast_employee_guid text primary key,
  toast_name          text not null,
  reason              text not null,
  recorded_at         timestamptz not null default now(),
  kind                text not null default 'device'
);

comment on table public.toast_non_human_guids is
  'Toast GUIDs that are NOT people (devices, default logins, confirmed '
  'non-employees) — consulted by ingest and any matcher so a device is '
  'never mapped and a recorded exclusion is never re-triaged. A matcher '
  'that must choose among employees cannot report that the answer is not '
  'an employee; this table is where that answer lives.';

insert into public.toast_non_human_guids
  (toast_employee_guid, toast_name, reason, kind, recorded_at)
values
  ('50f94fe0-076f-4e41-a981-336068504852', 'USER, KDS+KIOSK',
   'Generic hardware login profile used to sign into KDS / kiosk devices. Confirmed by Tucker 2026-08-26: never a person, never map, always ignore. Its only DTD entry (2026-07-10) is a 17.25h auto-close — a device left signed in.',
   'device', '2026-08-26 19:58:01.804478+00'),
  ('75ca71ec-0c06-46f0-9c5e-0d241c9b6e43', 'Default, Login',
   'Toast default login account, not a person.',
   'device', '2026-08-26 19:58:01.804478+00'),
  -- Wording corrected per Tucker's packet-6 §3 ruling (prod already
  -- carries this exact row): Dale was a noncrew/admin artifact, NOT
  -- "never on a roster" — the 2026-08-25 cleanup was deliberate and
  -- sanctioned, and the earlier framing of it as evidence destruction
  -- was wrong.
  ('81a3b568-a6e7-4b6b-b0e8-121f7293ba3f', 'Dale, Savanna',
   'Upper-management / admin artifact, not tracked crew. Held EMP-100015 (HOU) and EMP-100192 (NOLA) until the 2026-08-25 noncrew cleanup, which deliberately removed accounts of this class; payloads preserved in deleted_noncrew_employees_20260825. Tucker 2026-08-26: these accounts are irrelevant to the product''s goals and their data will never matter — ignore, do not track, do not re-create. Single COS punch 2026-07-08 stays unattributed by design.',
   'noncrew_artifact', '2026-08-26 20:03:10.994863+00')
on conflict (toast_employee_guid) do update
  set reason = excluded.reason, kind = excluded.kind;

-- ── §2 crosswalk attributions (employee_id/location_id resolved by code —
--       durable across databases; UUIDs are not) ───────────────────────────

with fixes(guid, employee_code, evidence, created_at) as (
  values
    ('73143fbc-9710-4d71-aa58-3272997a2d11', 'EMP-100240',
     '{"reason":"auto_behavioural committed a 13/16 date-containment match over a 16/16; every one of this GUID''s 16 punch dates falls on a Domynic Weesner scheduled shift","window":{"since":"2026-07-30","until":"2026-08-26"},"decided_at":"2026-08-26T16:43:58.616Z","punch_days":16,"thresholds":{"time_margin_min":15,"min_overlap_days":6,"time_ceiling_min":60},"corrected_by":"Tucker","corrected_on":"2026-08-26","eligible_count":1,"previous_owner":"EMP-100225 Taylor Garrison","best_overlap_days":13,"candidate_pool_size":13,"weesner_containment":"16/16","garrison_containment":"13/16","runner_up_overlap_days":null,"mutually_excluded_count":0,"median_clockin_delta_min":50.9,"runner_up_median_clockin_delta_min":null}'::jsonb,
     '2026-08-26 16:44:03.078325+00'),
    ('86c8b31c-45fe-425e-9636-d32ed2e0c353', 'EMP-100243',
     '{"note":"sole unmapped GUID at FCOL; sole unattributed 7shifts user at FCOL; the three shifts were flagged no_show and the punches disprove them","route":"human confirmation, corroborated by exact date match","punch_dates":["2026-08-21","2026-08-22","2026-08-23"],"confirmed_by":"Tucker","confirmed_on":"2026-08-26","matching_shift_dates":["2026-08-21","2026-08-22","2026-08-23"]}'::jsonb,
     '2026-08-26 19:13:32.635287+00'),
    ('0e7bd14d-2849-4b09-8d76-2897f2737d37', 'EMP-100226',
     '{"note":"count and range match exactly; had zero attributed punches before this","person":"Savannah Mallory","punches":5,"confirmed_by":"Tucker","confirmed_on":"2026-08-26","punch_window":["2026-08-03","2026-08-09"],"csu_shifts_in_window":5}'::jsonb,
     '2026-08-26 19:13:32.635287+00'),
    ('f1896727-6d82-406e-838b-3005761a5061', 'EMP-100237',
     '{"note":"count and range match exactly; had zero attributed punches before this","person":"Sage Mozier","punches":3,"confirmed_by":"Tucker","confirmed_on":"2026-08-26","punch_window":["2026-08-20","2026-08-23"],"csu_shifts_in_window":3}'::jsonb,
     '2026-08-26 19:13:32.635287+00'),
    ('cf8dc6d2-44e3-4222-8da1-ae40ab10e16a', 'EMP-100233',
     '{"note":"count and range match exactly; had zero attributed punches before this","person":"Isabella Garcia","punches":2,"confirmed_by":"Tucker","confirmed_on":"2026-08-26","punch_window":["2026-08-24","2026-08-26"],"csu_shifts_in_window":2}'::jsonb,
     '2026-08-26 19:13:32.635287+00'),
    ('f2b696c7-b03d-4c31-abe5-68a5de8c46b4', 'EMP-100173',
     '{"note":"identified by name from Toast''s own export; EPD row is archived but the four July punches are real","source":"Toast Time Entries export 2026-04-01 to 2026-08-26","toast_name":"Tell, Eland","confirmed_on":"2026-08-26"}'::jsonb,
     '2026-08-26 19:58:01.804478+00')
)
insert into public.toast_employee_crosswalk
  (toast_employee_guid, employee_id, location_id, match_method, evidence,
   created_at, updated_at)
select f.guid, e.id, e.location_id, 'manual', f.evidence,
       f.created_at::timestamptz, f.created_at::timestamptz
from fixes f
join public.employees e on e.employee_code = f.employee_code
on conflict (toast_employee_guid) do nothing;

-- ── §3 Garrison: excluded from the attendance denominator, BOTH stores ─────
-- (ruling 8 — null, never 0; punches_time_clock_since deliberately null:
-- the exclusion has no effective-date boundary, it describes the person.)

update public.employees
   set punches_time_clock = false
 where employee_code in ('EMP-100225', 'EMP-100100')
   and punches_time_clock is distinct from false;

-- ── §4 RLS + revoke over every RLS-less public table (packet 6 §2) ─────────
--
-- What was found: 22 Cowork-created reference/snapshot tables (the
-- %_20260825 / %_20260826 families + toast_non_human_guids) sat with
-- rls_enabled = false AND Supabase's default full grants to anon +
-- authenticated — world-writable through PostgREST with the anon key.
-- Tucker: "Keep and widen to all 22 — APPROVED." Already applied in prod
-- 2026-08-26 night (verified: zero public tables without RLS, zero
-- granting anon); this loop is the parity record.
--
-- ⚠️ WHY THE REVOKE IS MANDATORY, NOT BELT-AND-BRACES: TRUNCATE and
-- REFERENCES are NOT subject to row security. RLS alone would have left
-- all 22 truncatable by anon — a guard that covers most verbs is not a
-- guard on the verb it misses, and TRUNCATE is the one that empties the
-- table.
--
-- Written as a loop over the CATALOG, not a 22-name list: the next
-- `create table ... as select` inherits the same defaults, and a list is
-- stale the day after it is written (that is how twenty-two accumulated
-- across two sessions without either being noticed). The standing check
-- lives in supabase/tests/rls_coverage_test.sql.

do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind='r' and c.relrowsecurity = false
  loop
    execute format('alter table public.%I enable row level security', t.relname);
    execute format('revoke all on public.%I from anon, authenticated', t.relname);
  end loop;
end $$;
