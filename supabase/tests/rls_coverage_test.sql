-- RLS coverage test (packet 6 §2, Tucker-approved 2026-08-26): ZERO public
-- tables may have relrowsecurity = false.
--
-- WHY A STANDING TEST: the next `create table ... as select` (a Cowork
-- snapshot load, an ad-hoc reference table) inherits RLS-off + Supabase's
-- default full grants to anon/authenticated — world-writable through
-- PostgREST — and nobody will remember. That is exactly how TWENTY-TWO
-- such tables accumulated across two sessions without either being
-- noticed. Note TRUNCATE/REFERENCES are NOT subject to row security, which
-- is why mig 082 §4 pairs the RLS enable with `revoke all` on the affected
-- tables.
--
-- Deliberately NOT asserted: "zero anon grants estate-wide". The app's own
-- tables carry Supabase's default schema grants and rely on RLS to gate
-- rows — that is the platform's standard posture, PostgREST cannot issue
-- TRUNCATE, and revoking estate-wide would be a behaviour change nobody
-- ruled. The invariant that catches the real failure mode is the RLS bit.
--
-- MECHANISM (the phase_b_policy_tests.sql pattern): run via Supabase MCP
-- execute_sql or psql as postgres/service role. Read-only — raises on
-- failure, emits 'RLS COVERAGE: ALL PASSED' on success. Run it after any
-- session that created tables in prod.

do $$
declare
  bad_rls text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into bad_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and c.relrowsecurity = false;
  if bad_rls is not null then
    raise exception 'RLS COVERAGE FAILED: public tables without RLS: %', bad_rls;
  end if;

  raise notice 'RLS COVERAGE: ALL PASSED';
end $$;
