-- ============================================================================
-- Tasks ingest + accountability + per-employee metrics.
-- ============================================================================

create table public.tasks (
  id                       uuid primary key default uuid_generate_v4(),
  location_id              uuid not null references public.locations(id) on delete cascade,
  task_list_name           text not null,
  task_name                text not null,
  task_date                date not null,
  start_time               time,
  due_time                 time,
  task_type                text,
  recurrence               text,
  is_complete              boolean not null default false,
  earliest_completion_at   timestamptz,
  latest_completion_at     timestamptz,
  raw_completers           jsonb,
  source                   text not null default 'whentowork',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (location_id, task_list_name, task_name, task_date, start_time)
);
create index idx_tasks_loc_date on public.tasks(location_id, task_date);

create table public.task_accountability (
  task_id          uuid not null references public.tasks(id) on delete cascade,
  employee_id      uuid not null references public.employees(id) on delete cascade,
  overlap_minutes  int  not null,
  primary key (task_id, employee_id)
);
create index idx_task_accountability_emp on public.task_accountability(employee_id);

create trigger trg_tasks_updated
  before update on public.tasks
  for each row execute function public.set_updated_at();

alter table public.tasks               enable row level security;
alter table public.task_accountability enable row level security;
create policy "tasks_authenticated_all"
  on public.tasks               for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);
create policy "task_accountability_authenticated_all"
  on public.task_accountability for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);

alter table public.performance_records
  add column tasks_accountable             int,
  add column tasks_completed               int,
  add column task_completion_pct           numeric,
  add column task_list_completion_pct      numeric,
  add column avg_task_list_completion_pct  numeric;
