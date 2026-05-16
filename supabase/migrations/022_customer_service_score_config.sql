-- ============================================================================
-- 022_customer_service_score_config.sql — Phase 9: weight config singleton
-- ============================================================================
-- A 0–100 Customer Service Score per (employee, quarter) blending three
-- signals (Tattle ratings, customer reviews, tip-rate delta). The weights are
-- globally configurable. Per-client/per-location overrides are deferred.
--
-- Singleton enforcement: a partial unique index on a constant TRUE expression
-- guarantees at most one row. The defaults below are inserted on migration
-- apply.
-- ============================================================================

create table public.customer_service_score_config (
  id              uuid primary key default uuid_generate_v4(),
  weight_tattle   numeric(4,3) not null default 0.400,
  weight_reviews  numeric(4,3) not null default 0.400,
  weight_tip      numeric(4,3) not null default 0.200,
  updated_at      timestamptz not null default now(),
  constraint weights_sum_to_one
    check (round(weight_tattle + weight_reviews + weight_tip, 3) = 1.000),
  constraint weights_non_negative
    check (weight_tattle >= 0 and weight_reviews >= 0 and weight_tip >= 0)
);

create unique index customer_service_score_config_singleton
  on public.customer_service_score_config ((true));

create trigger trg_customer_service_score_config_updated
  before update on public.customer_service_score_config
  for each row execute function public.set_updated_at();

alter table public.customer_service_score_config enable row level security;
create policy "customer_service_score_config_authenticated_all"
  on public.customer_service_score_config for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);

insert into public.customer_service_score_config (weight_tattle, weight_reviews, weight_tip)
  values (0.400, 0.400, 0.200);
