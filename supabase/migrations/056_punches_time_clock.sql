-- ============================================================================
-- 056_punches_time_clock.sql — evidenced non-puncher marker (defect §11),
-- EFFECTIVE-DATED (flip spec 2026-08-24 §2a)
-- ============================================================================
-- Tucker's ruling 2026-08-24: some employees structurally do not clock in
-- (salaried managers). Left alone they read 0% attendance forever once
-- punches drive the metric — the same class of wrong-number this sprint
-- exists to fix, reintroduced from the other direction.
--
-- ⚠️ THE MARKER IS EFFECTIVE-DATED. punches_time_clock is a time-invariant
-- flag but it encodes a fact that can BEGIN at a date: Nick Goins punched
-- normally for three quarters (~80% attendance) and stopped exactly when COS
-- moved to Toast (go-live 2026-07-07). A bare boolean would null all four of
-- his persisted quarters — discarding three legitimate records and silently
-- altering Q4 2025, a THQ frozen quarter, which is precisely what the
-- frozen-quarter arrangement exists to prevent. punches_time_clock_since
-- scopes the exclusion: it applies only to periods that OVERLAP
-- [since, ∞) — a period ending before the effective date scores normally.
-- A null since means "always" (a historic non-puncher with no punching era).
--
-- ⚠️ BOTH FIELDS ARE DELIBERATELY INGEST-IMMUNE. wage_pay_type cannot carry
-- this signal: it is WRITTEN by the employee CSV upload
-- (upload-actions.ts:71 — any row carrying a wage overwrites it), so a
-- manual 'Salary' dies on the next upload. punches_time_clock is written by
-- exactly two things: this migration's seed and the SA employee-edit
-- surface. No ingest, import, or matcher touches it (pinned by test).
--
-- ⚠️ DO NOT DERIVE THIS from wage_pay_type or job title — measured
-- 2026-08-24: six of seven GMs punch normally (one at 42 of 42 scheduled
-- days). Title- or pay-type-based exclusion would discard good attendance
-- data for six people to fix one. false is set only where a full window
-- shows zero punches against a real schedule AND an SA has confirmed it.
--
-- Consumers: the recompute entry points gate on punchesTimeClockForPeriod
-- (marker + since vs the period end); when the exclusion applies,
-- computeMetricsFromEntries nulls the attendance/punctuality family — the
-- employee is EXCLUDED from the denominator (null = not-computable per the
-- wire contracts), never scored zero. Pinned by performance-recompute tests.
--
-- Seed: exactly one employee — Nick Goins (COS), verified live 2026-08-24
-- (0 punches against a real schedule since COS's Toast go-live; salaried per
-- Tucker; verified NOT punching under another account — closest COS Toast
-- candidate fits his schedule at a 122-minute median). since = 2026-07-07,
-- COS's toast_sales_start_date (mig 038).
--
-- FILE-ONLY until Cowork/Tucker applies via MCP (repo↔prod parity pattern).
-- Additive; safe ahead of the code.
-- ============================================================================

alter table public.employees
  add column if not exists punches_time_clock boolean not null default true;

alter table public.employees
  add column if not exists punches_time_clock_since date;

comment on column public.employees.punches_time_clock is
  'false = evidenced non-puncher (salaried, no clock-ins against a real schedule; SA-confirmed). Excludes the employee from punch-based attendance denominators (null, never 0) for periods overlapping punches_time_clock_since. SA-set only — deliberately untouched by every ingest and import; NOT derivable from wage_pay_type or title (6 of 7 GMs punch normally).';

comment on column public.employees.punches_time_clock_since is
  'Effective date of the non-puncher exclusion: it applies only to periods overlapping [since, ∞); periods ending before this date score normally (protects pre-Toast history and THQ frozen quarters). Null = always. Meaningless while punches_time_clock is true.';

-- The guard makes re-applies true no-ops AND protects a later SA re-enable
-- from being reverted by a repeated manual run.
update public.employees
set punches_time_clock = false,
    punches_time_clock_since = date '2026-07-07', -- COS Toast go-live (mig 038)
    updated_at = now()
where id = '9303203e-88f2-423f-af56-b4056a6580cc' -- Nick Goins, COS
  and (punches_time_clock is distinct from false
       or punches_time_clock_since is distinct from date '2026-07-07');

-- ⚠️ POST-APPLY: persisted performance_records rows computed BEFORE this
-- seed still carry Nick's stale attendance values (and /api/scores serves
-- them) until his (employee × quarter) set is recomputed — trigger a
-- recompute (Scoring-page save or the next nightly touching him) right
-- after applying. The seed itself cannot do this: the recompute is TS-side.
-- With the effective date, that recompute nulls ONLY Q3 2026 onward; his
-- Q4 2025 / Q1 2026 / Q2 2026 values recompute to the same ~80% numbers.
