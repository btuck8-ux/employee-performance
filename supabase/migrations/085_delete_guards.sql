-- 085: hard-delete guards — employees AND locations (ruling 12 + packet 5
-- §7.5). ⛔ FILE-ONLY until its apply motion, like 079/083/084.
--
-- The blast radius being guarded: employees cascades to 12 tables
-- including time_entries; locations cascades to 13 including employees —
-- deleting ONE location destroys every employee at that store and their
-- entire history, through a second cascade.
--
-- WHY A TRIGGER, NOT AN RLS POLICY: service_role BYPASSES RLS, and that is
-- the path the app actually uses — an RLS policy here is a function the
-- admin client never calls. A BEFORE DELETE trigger fires for every
-- deleter, including service_role and cascades. The revokes below are
-- defence in depth for the non-service paths.
--
-- ESCAPE HATCH (documented, deliberate): a session setting that must name
-- the guarded table(s) explicitly, inside the deleting transaction:
--
--   begin;
--   set local epd.allow_hard_delete = 'employees';
--   delete from public.employees where id = '...';
--   commit;
--
-- The value is a comma-separated allow-list of table names. A LOCATION
-- delete cascades into employees, whose trigger fires per cascaded row —
-- so destroying a store requires naming BOTH, which is the point (the
-- second cascade must be a conscious choice, not a surprise):
--
--   set local epd.allow_hard_delete = 'locations,employees';

create or replace function public.forbid_hard_delete()
returns trigger
language plpgsql as $$
begin
  if tg_table_name = any(
    string_to_array(
      coalesce(current_setting('epd.allow_hard_delete', true), ''), ','
    )
  ) then
    return old;
  end if;
  raise exception
    'hard delete of %.% is forbidden (ruling 12, mig 085) — archive/deactivate instead. Operator escape hatch: SET LOCAL epd.allow_hard_delete = ''%'' inside the deleting transaction (comma-separate to authorize cascades).',
    tg_table_schema, tg_table_name, tg_table_name;
end $$;

comment on function public.forbid_hard_delete() is
  'BEFORE DELETE guard (ruling 12, packet 5 §7.5): blocks hard deletes of '
  'guarded tables unless the session setting epd.allow_hard_delete names '
  'the table (CSV allow-list; cascaded deletes fire the target table''s '
  'trigger too, so a location delete must name employees as well). '
  'Trigger-shaped because service_role bypasses RLS.';

drop trigger if exists employees_forbid_hard_delete on public.employees;
create trigger employees_forbid_hard_delete
  before delete on public.employees
  for each row execute function public.forbid_hard_delete();

drop trigger if exists locations_forbid_hard_delete on public.locations;
create trigger locations_forbid_hard_delete
  before delete on public.locations
  for each row execute function public.forbid_hard_delete();

-- Defence in depth: the client-facing roles never hard-delete these rows,
-- whatever a future policy accidentally grants.
revoke delete on public.employees from anon, authenticated;
revoke delete on public.locations from anon, authenticated;
