-- 063: report_periods.frozen — frozen-ness is a property of the period,
-- not a date in code (frozen-quarter spec 2026-08-25 §1a).
--
-- WHY: "frozen" previously lived as a hardcoded `year < 2026` comparison in
-- the recompute lever — a guard on ONE caller of a 20-write-path asset. That
-- drifts (Q1 2026 will freeze eventually and nothing will notice) and lets
-- two callers disagree about what frozen means. The flag moves the fact into
-- the data: freezing a future quarter becomes a data change, not a deploy.
--
-- The guard that reads this flag lives inside recomputePerformanceForQuarter
-- (performance-recompute.ts) — a guard attached to the asset protects the
-- asset. Agreed rule with Training HQ, 2026-08-25.

alter table public.report_periods
  add column if not exists frozen boolean not null default false;

comment on column public.report_periods.frozen is
  'Recompute writes to this period are refused unless the caller passes an '
  'override naming this exact quarter (allowFrozenQuarter). Q3/Q4 2025 are '
  'frozen under the THQ arrangement. Freeze a quarter by flipping this flag '
  '— never by adding a date comparison in code.';

-- Seed: the two quarters actually under the THQ arrangement. upsert_quarter
-- first so the rows exist even on a fresh database (idempotent).
select public.upsert_quarter(2025, 3);
select public.upsert_quarter(2025, 4);

update public.report_periods
   set frozen = true
 where year = 2025
   and quarter in (3, 4);
