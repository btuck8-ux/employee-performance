-- 093_performance_records_location_axis.sql
--
-- Reconstructed 2026-09-01 from live schema. The original was applied to prod at
-- 2026-09-01 02:18:33 UTC (schema_migrations version 20260901021833) without ever
-- being committed; this file restores repo/prod parity so a db reset or a fresh
-- environment reproduces the constraint prod actually enforces.
--
-- The location axis: a performance record is unique per (employee, period, STORE),
-- not per (employee, period). See the one-master-code ruling and the merge
-- arithmetic spec. performance_records.location_id has been `not null` since
-- 001_init_schema.sql, so no nullability change is needed or implied here.

alter table public.performance_records
  drop constraint if exists performance_records_employee_id_report_period_id_key;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.performance_records'::regclass
      and conname  = 'performance_records_employee_period_location_key'
  ) then
    alter table public.performance_records
      add constraint performance_records_employee_period_location_key
      unique (employee_id, report_period_id, location_id);
  end if;
end $$;
