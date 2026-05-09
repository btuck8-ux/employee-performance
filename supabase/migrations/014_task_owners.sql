-- task_owners records who personally completed each task (via "Completed By"
-- column → fuzzy-matched to an active employee). Independent of accountability.
create table public.task_owners (
  task_id      uuid not null references public.tasks(id) on delete cascade,
  employee_id  uuid not null references public.employees(id) on delete cascade,
  matched_name text,
  match_confidence text,
  primary key (task_id, employee_id)
);
create index idx_task_owners_employee on public.task_owners(employee_id);

alter table public.task_owners enable row level security;
create policy "task_owners_authenticated_all"
  on public.task_owners for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);

alter table public.performance_records
  add column tasks_owned int;
