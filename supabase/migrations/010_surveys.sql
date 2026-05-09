-- ============================================================================
-- Survey engagement ingest (initially from 7taps, exported via Claude in Chrome).
-- ============================================================================

create table public.surveys (
  id                   uuid primary key default uuid_generate_v4(),
  location_id          uuid not null references public.locations(id) on delete cascade,
  external_survey_id   text,
  title                text not null,
  sent_date            date,
  source               text not null default '7taps',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (location_id, title, sent_date)
);
create index idx_surveys_loc_date on public.surveys(location_id, sent_date);

create table public.survey_assignments (
  id                  uuid primary key default uuid_generate_v4(),
  survey_id           uuid not null references public.surveys(id) on delete cascade,
  employee_id         uuid not null references public.employees(id) on delete cascade,
  completed           boolean not null default false,
  completion_date     date,
  response_data       jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (survey_id, employee_id)
);
create index idx_survey_assignments_employee on public.survey_assignments(employee_id);

create trigger trg_surveys_updated
  before update on public.surveys
  for each row execute function public.set_updated_at();
create trigger trg_survey_assignments_updated
  before update on public.survey_assignments
  for each row execute function public.set_updated_at();

alter table public.surveys             enable row level security;
alter table public.survey_assignments  enable row level security;
create policy "surveys_authenticated_all"
  on public.surveys             for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);
create policy "survey_assignments_authenticated_all"
  on public.survey_assignments  for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);
