-- ============================================================================
-- 051_metric_targets.sql — global per-metric targets (two-tier evaluation)
-- ============================================================================
-- Targets sprint (kickoff-targets-plus-range-api-2026-08-14.md §3; THQ
-- contract memo 2026-08-14 §1). EPD adopts THQ's nine target values verbatim
-- (Tucker directive, cross-app) and retires the hardcoded three-tier
-- Below/Meets/Exceeds bands in classify.ts for these nine metrics: the app
-- now evaluates value >= target -> "On Target", else "Below Target" (null
-- stays unclassified). Targets are GLOBAL config — one row per metric key,
-- SA-editable on the admin Scoring page. This is deliberately NOT the
-- per-location `metric_thresholds` table (which stays, unused by the nine).
--
-- Scales are locked with THQ: tattle_rating / customer_service_rating are
-- native 1–5; everything else is 0–100. Targets feed CLASSIFICATION ONLY —
-- composite math (CS Score / Total Impact) is weight-based and reads nothing
-- from this table (verified 2026-08-14: neither the TS engines nor SQL
-- 023/025/026 touch classification bands).
--
-- RLS follows the 047 Class-7 pattern (all-signed-in read, SA-only write) —
-- reference config, same class as metric_thresholds. updated_at rides the 001
-- set_updated_at() trigger convention.
--
-- Apply via Cowork/Tucker MCP AFTER Codex review, BEFORE the config/
-- metric-targets PR merges; this file is the parity copy (repo↔prod pattern).
-- Safe to apply ahead of the code: purely additive.
-- ============================================================================

create table public.metric_targets (
  metric_key text primary key
    check (metric_key in (
      'on_time_grace_pct',
      'attendance_pct',
      'survey_engagement_pct',
      'tattle_rating',
      'customer_service_rating',
      'tattle_score_food_quality',
      'tattle_score_accuracy',
      'tattle_score_speed_of_service',
      'avg_task_list_completion_pct'
    )),
  target     numeric not null check (target >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.metric_targets is
  'Global per-metric targets (THQ-aligned, 2026-08-14). Two-tier: value >= target -> On Target, else Below Target. Ratings native 1-5, everything else 0-100. Classification input only — never composite math.';

create trigger trg_metric_targets_updated
  before update on public.metric_targets
  for each row execute function public.set_updated_at();

-- The nine THQ values, adopted verbatim (Tucker, 2026-08-14).
insert into public.metric_targets (metric_key, target) values
  ('on_time_grace_pct',             95),
  ('attendance_pct',                95),
  ('survey_engagement_pct',         100),
  ('tattle_rating',                 4.75),
  ('customer_service_rating',       4.75),
  ('tattle_score_food_quality',     95),
  ('tattle_score_accuracy',         95),
  ('tattle_score_speed_of_service', 95),
  ('avg_task_list_completion_pct',  100);

-- ── RLS: Class 7 — all-signed-in read, SA-only write (047 conventions) ──────
alter table public.metric_targets enable row level security;

create policy metric_targets_read on public.metric_targets
  for select to authenticated using (true);
create policy metric_targets_sa_write on public.metric_targets
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));
