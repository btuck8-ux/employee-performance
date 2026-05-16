-- ============================================================================
-- 024_total_impact_score_config.sql — Phase 10: weight config singleton
-- ============================================================================
-- A 0–100 Total Impact Score per (employee, range) blending five components:
--   Customer Service Score (Phase 9 composite, 40% default)
--   Attendance %                                 (15% default)
--   On-time % (grace-aware)                      (15% default)
--   Avg task-list completion %                   (15% default)
--   Survey engagement %                          (15% default)
--
-- Weights are globally configurable. Singleton row enforced via a partial
-- unique index on a constant TRUE expression (same pattern as Phase 9). The
-- CHECK constraint guarantees the five weights sum to exactly 1.000.
--
-- The "CS Score 40% framing" rolls back up — when CS Score's three leaf
-- signals (Tattle 40% / Reviews 40% / Tip 20%) are unrolled within the 40%
-- CS allocation, the effective platform-wide weights are:
--   Tattle 16% · Reviews 16% · Tip 8% (customer signals = 40%)
--   Attendance / On-time / Tasks / Survey 15% each (behavioral = 60%)
-- That's the second-order math; managers see the first-order framing.
-- ============================================================================

create table public.total_impact_score_config (
  id                  uuid primary key default uuid_generate_v4(),
  weight_cs_score     numeric(4,3) not null default 0.400,
  weight_attendance   numeric(4,3) not null default 0.150,
  weight_on_time      numeric(4,3) not null default 0.150,
  weight_tasks        numeric(4,3) not null default 0.150,
  weight_survey       numeric(4,3) not null default 0.150,
  updated_at          timestamptz not null default now(),
  constraint tis_weights_sum_to_one
    check (round(
      weight_cs_score + weight_attendance + weight_on_time + weight_tasks + weight_survey,
      3
    ) = 1.000),
  constraint tis_weights_non_negative
    check (weight_cs_score >= 0
       and weight_attendance >= 0
       and weight_on_time >= 0
       and weight_tasks >= 0
       and weight_survey >= 0)
);

create unique index total_impact_score_config_singleton
  on public.total_impact_score_config ((true));

create trigger trg_total_impact_score_config_updated
  before update on public.total_impact_score_config
  for each row execute function public.set_updated_at();

alter table public.total_impact_score_config enable row level security;
create policy "total_impact_score_config_authenticated_all"
  on public.total_impact_score_config for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);

insert into public.total_impact_score_config
  (weight_cs_score, weight_attendance, weight_on_time, weight_tasks, weight_survey)
  values (0.400, 0.150, 0.150, 0.150, 0.150);
