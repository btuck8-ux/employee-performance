-- ============================================================================
-- Employee Performance Platform — Initial Schema
-- ============================================================================
-- Open-access MVP: RLS = auth.uid() IS NOT NULL on all tables.
-- Quarterly periods only. Tolerant ingest. Versioned reports.

-- ---------- Extensions ----------
create extension if not exists "uuid-ossp";

-- ---------- Enums ----------
create type user_role as enum ('admin', 'manager', 'viewer');
create type upload_source as enum ('ui', 'csv_upload', 'xlsx_upload');
create type upload_file_format as enum ('csv', 'xlsx');
create type upload_status as enum ('parsing', 'success', 'partial', 'failed');
create type generation_status as enum ('running', 'success', 'partial', 'failed');
create type generation_mode as enum ('quarterly', 'custom_range');

-- ---------- Identity ----------
create table public.clients (
  id           uuid primary key default uuid_generate_v4(),
  name         text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.locations (
  id                       uuid primary key default uuid_generate_v4(),
  client_id                uuid not null references public.clients(id) on delete cascade,
  name                     text not null,
  active                   boolean not null default true,
  last_data_uploaded_at    timestamptz,
  last_report_generated_at timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index idx_locations_client on public.locations(client_id);

create table public.employees (
  id            uuid primary key default uuid_generate_v4(),
  location_id   uuid not null references public.locations(id) on delete cascade,
  external_id   text,
  employee_name text not null,
  hire_date     date,
  active        boolean not null default true,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique(location_id, external_id)
);
create index idx_employees_location on public.employees(location_id);
create index idx_employees_name on public.employees(location_id, lower(employee_name));

-- Mirrors auth.users; auto-populated by trigger on first sign-in.
create table public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  role        user_role not null default 'admin',  -- unused in MVP
  can_upload  boolean not null default true,        -- unused in MVP
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.user_location_access (
  user_id     uuid not null references public.users(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  primary key (user_id, location_id)
);

-- Auto-mirror auth.users -> public.users on signup
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

-- ---------- Configuration ----------
create table public.report_periods (
  id            uuid primary key default uuid_generate_v4(),
  label         text not null,
  year          int  not null,
  quarter       int  not null check (quarter between 1 and 4),
  period_start  date not null,
  period_end    date not null,
  created_at    timestamptz not null default now(),
  unique (year, quarter)
);

create or replace function public.upsert_quarter(p_year int, p_quarter int)
returns uuid language plpgsql as $$
declare
  v_id uuid;
  v_start date;
  v_end date;
  v_label text;
begin
  if p_quarter not between 1 and 4 then
    raise exception 'Invalid quarter %', p_quarter;
  end if;
  v_start := make_date(p_year, ((p_quarter - 1) * 3) + 1, 1);
  v_end   := (v_start + interval '3 months' - interval '1 day')::date;
  v_label := 'Q' || p_quarter || ' ' || p_year;
  insert into public.report_periods (label, year, quarter, period_start, period_end)
  values (v_label, p_year, p_quarter, v_start, v_end)
  on conflict (year, quarter) do update set label = excluded.label
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.quarter_of(d date)
returns table(year int, quarter int) language sql immutable as $$
  select extract(year from d)::int, ((extract(month from d)::int - 1) / 3) + 1;
$$;

create table public.metric_thresholds (
  id                uuid primary key default uuid_generate_v4(),
  location_id       uuid not null references public.locations(id) on delete cascade,
  report_period_id  uuid references public.report_periods(id) on delete cascade,
  metric_key        text not null,
  good_min          numeric not null,
  needs_min         numeric not null,
  avg_value         numeric,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (location_id, report_period_id, metric_key)
);
create index idx_thresholds_loc_period on public.metric_thresholds(location_id, report_period_id);

-- ---------- Records ----------
create table public.data_uploads (
  id               uuid primary key default uuid_generate_v4(),
  location_id      uuid references public.locations(id) on delete set null,
  report_period_id uuid references public.report_periods(id) on delete set null,
  filename         text not null,
  file_format      upload_file_format not null,
  storage_path     text,
  status           upload_status not null default 'parsing',
  message          text,
  rows_processed   int not null default 0,
  rows_failed      int not null default 0,
  errors           jsonb not null default '[]'::jsonb,
  uploaded_by      uuid references public.users(id) on delete set null,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz not null default now()
);
create index idx_uploads_location on public.data_uploads(location_id);

create table public.performance_records (
  id                              uuid primary key default uuid_generate_v4(),
  employee_id                     uuid not null references public.employees(id) on delete cascade,
  location_id                     uuid not null references public.locations(id) on delete cascade,
  report_period_id                uuid not null references public.report_periods(id) on delete cascade,
  on_time_pct                     numeric,
  attendance_pct                  numeric,
  covered_shifts                  int,
  survey_engagement_pct           numeric,
  customer_service_rating         numeric,
  customer_review_quantity        int,
  tattle_rating                   numeric,
  tattle_quantity                 int,
  tattle_score_food_quality       numeric,
  tattle_score_accuracy           numeric,
  tattle_score_speed_of_service   numeric,
  manager_feedback                text,
  source                          upload_source not null default 'ui',
  source_upload_id                uuid references public.data_uploads(id) on delete set null,
  raw_row                         jsonb,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  updated_by                      uuid references public.users(id) on delete set null,
  unique (employee_id, report_period_id)
);
create index idx_records_location_period on public.performance_records(location_id, report_period_id);
create index idx_records_employee on public.performance_records(employee_id);

create table public.generated_reports (
  id                                  uuid primary key default uuid_generate_v4(),
  performance_record_id               uuid references public.performance_records(id) on delete set null,
  employee_id                         uuid not null references public.employees(id) on delete cascade,
  location_id                         uuid not null references public.locations(id) on delete cascade,
  report_period_id                    uuid references public.report_periods(id) on delete set null,
  generation_mode                     generation_mode not null default 'quarterly',
  custom_range                        jsonb,
  aggregated_period_ids               jsonb,
  storage_path                        text not null,
  template_version                    text not null,
  threshold_snapshot                  jsonb,
  generated_at                        timestamptz not null default now(),
  generated_by                        uuid references public.users(id) on delete set null,
  superseded_at                       timestamptz,
  feedback_updated_after_generation   boolean not null default false,
  created_at                          timestamptz not null default now()
);
create index idx_reports_employee_period on public.generated_reports(employee_id, report_period_id) where superseded_at is null;
create index idx_reports_location on public.generated_reports(location_id);

create table public.report_generation_logs (
  id                 uuid primary key default uuid_generate_v4(),
  location_id        uuid references public.locations(id) on delete set null,
  report_period_id   uuid references public.report_periods(id) on delete set null,
  status             generation_status not null default 'running',
  message            text,
  reports_generated  int not null default 0,
  reports_failed     int not null default 0,
  errors             jsonb not null default '[]'::jsonb,
  triggered_by       uuid references public.users(id) on delete set null,
  started_at         timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz not null default now()
);
create index idx_genlogs_location on public.report_generation_logs(location_id);

-- ---------- updated_at triggers ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

do $$
declare t text;
begin
  for t in select unnest(array['clients','locations','employees','users','metric_thresholds','performance_records']) loop
    execute format('create trigger trg_%I_updated before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ---------- Mark feedback-changed flag on update ----------
create or replace function public.flag_feedback_change()
returns trigger language plpgsql as $$
begin
  if new.manager_feedback is distinct from old.manager_feedback then
    update public.generated_reports
       set feedback_updated_after_generation = true
     where performance_record_id = new.id
       and superseded_at is null;
  end if;
  return new;
end; $$;

create trigger trg_flag_feedback_change
after update of manager_feedback on public.performance_records
for each row execute function public.flag_feedback_change();
