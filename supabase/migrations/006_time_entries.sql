-- ============================================================================
-- time_entries: one row per (employee, date, entry_type).
-- entry_type is 'scheduled' (what they were supposed to work) or
-- 'worked' (what they actually punched). Multiple shifts on the same day
-- are collapsed to a single entry: earliest in, latest out, summed hours/pay.
-- Cross-referencing scheduled vs worked drives attendance_pct, on_time_pct,
-- and covered_shifts on performance_records.
-- ============================================================================

create type time_entry_type as enum ('scheduled', 'worked');

create table public.time_entries (
  id                uuid primary key default uuid_generate_v4(),
  employee_id       uuid not null references public.employees(id) on delete cascade,
  location_id       uuid not null references public.locations(id) on delete cascade,
  entry_date        date not null,
  entry_type        time_entry_type not null,
  in_time           time,
  out_time          time,
  role              text,
  wage              numeric,
  regular_hours     numeric default 0,
  ot_hours          numeric default 0,
  double_ot_hours   numeric default 0,
  holiday_hours     numeric default 0,
  regular_pay       numeric default 0,
  ot_pay            numeric default 0,
  double_ot_pay     numeric default 0,
  holiday_pay       numeric default 0,
  total_pay         numeric default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (employee_id, entry_date, entry_type)
);

create index idx_time_entries_lookup
  on public.time_entries (location_id, entry_date, entry_type);

create index idx_time_entries_employee_period
  on public.time_entries (employee_id, entry_date);

create trigger trg_time_entries_updated
  before update on public.time_entries
  for each row execute function public.set_updated_at();

alter table public.time_entries enable row level security;
create policy "time_entries_authenticated_all"
  on public.time_entries
  for all to authenticated
  using (auth.uid() is not null)
  with check (auth.uid() is not null);
