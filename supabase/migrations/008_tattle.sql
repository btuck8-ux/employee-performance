-- ============================================================================
-- Tattle survey ingest.
--
--   tattle_surveys     = one row per (location, external_tattle_id) — the
--                        survey-level rollup. Stores the standard-3 category
--                        scores (Accuracy, Food Quality, Speed of Service) as
--                        denormalized columns + survey-wide rating/score and
--                        all comments concatenated.
--
--   tattle_responses   = one row per (survey, category) — preserves every
--                        category from the source CSV including extras like
--                        Hospitality / Cleanliness, plus per-category weights,
--                        comments, and positive/negative factor tags.
--
--   tattle_attributions = many-to-many between tattle_surveys and employees
--                        based on who was on shift at local_datetime_experienced
--                        (or, if no one was, who worked that day).
--
-- performance_records gains tattle_summary + tattle_summary_generated_at for
-- AI-generated summaries (manual trigger).
-- ============================================================================

create type tattle_attribution_method as enum (
  'on_shift_at_experienced',
  'worked_that_day'
);

create table public.tattle_surveys (
  id                       uuid primary key default uuid_generate_v4(),
  location_id              uuid not null references public.locations(id) on delete cascade,
  external_tattle_id       text not null,
  external_survey_id       text,
  external_location_id     text,
  datetime_experienced     timestamptz,
  date_experienced         date,
  datetime_created         timestamptz,
  tattle_rating            int,
  tattle_score             numeric,
  food_quality_score       numeric,
  accuracy_score           numeric,
  speed_of_service_score   numeric,
  comments_combined        text,
  positive_factors_combined text,
  negative_factors_combined text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (location_id, external_tattle_id)
);
create index idx_tattle_surveys_loc_date on public.tattle_surveys(location_id, date_experienced);

create table public.tattle_responses (
  id                  uuid primary key default uuid_generate_v4(),
  tattle_survey_id    uuid not null references public.tattle_surveys(id) on delete cascade,
  category            text not null,
  weight              numeric,
  comment             text,
  positive_factors    text,
  negative_factors    text,
  raw_row             jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tattle_survey_id, category)
);

create table public.tattle_attributions (
  tattle_survey_id     uuid not null references public.tattle_surveys(id) on delete cascade,
  employee_id          uuid not null references public.employees(id) on delete cascade,
  attribution_method   tattle_attribution_method not null,
  attributed_at        timestamptz not null default now(),
  primary key (tattle_survey_id, employee_id)
);
create index idx_tattle_attributions_employee on public.tattle_attributions(employee_id);

create trigger trg_tattle_surveys_updated
  before update on public.tattle_surveys
  for each row execute function public.set_updated_at();
create trigger trg_tattle_responses_updated
  before update on public.tattle_responses
  for each row execute function public.set_updated_at();

alter table public.tattle_surveys      enable row level security;
alter table public.tattle_responses    enable row level security;
alter table public.tattle_attributions enable row level security;
create policy "tattle_surveys_authenticated_all"
  on public.tattle_surveys     for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);
create policy "tattle_responses_authenticated_all"
  on public.tattle_responses   for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);
create policy "tattle_attributions_authenticated_all"
  on public.tattle_attributions for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);

alter table public.performance_records
  add column tattle_summary              text,
  add column tattle_summary_generated_at timestamptz;
