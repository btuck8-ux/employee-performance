-- ============================================================================
-- Online customer reviews (Google, Yelp, etc.) ingest.
-- Parallels the tattle pipeline:
--   customer_reviews     = one row per review.
--   review_attributions  = many-to-many to employees, with on-shift / worked-day method.
-- Rename tattle_attribution_method -> attribution_method since it's now shared.
-- ============================================================================

alter type tattle_attribution_method rename to attribution_method;

create table public.customer_reviews (
  id                       uuid primary key default uuid_generate_v4(),
  location_id              uuid not null references public.locations(id) on delete cascade,
  external_review_id       text not null,
  provider_name            text,
  external_location_id     text,
  external_location_label  text,
  rating                   numeric,
  reviewer                 text,
  review_text              text,
  review_url               text,
  review_datetime          timestamptz,
  review_date              date,
  response_text            text,
  response_datetime        timestamptz,
  response_status          text,
  response_username        text,
  response_type            text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (location_id, external_review_id)
);
create index idx_customer_reviews_loc_date on public.customer_reviews(location_id, review_date);

create table public.review_attributions (
  customer_review_id   uuid not null references public.customer_reviews(id) on delete cascade,
  employee_id          uuid not null references public.employees(id) on delete cascade,
  attribution_method   attribution_method not null,
  attributed_at        timestamptz not null default now(),
  primary key (customer_review_id, employee_id)
);
create index idx_review_attributions_employee on public.review_attributions(employee_id);

create trigger trg_customer_reviews_updated
  before update on public.customer_reviews
  for each row execute function public.set_updated_at();

alter table public.customer_reviews    enable row level security;
alter table public.review_attributions enable row level security;
create policy "customer_reviews_authenticated_all"
  on public.customer_reviews     for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);
create policy "review_attributions_authenticated_all"
  on public.review_attributions  for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);
