-- ============================================================================
-- 056_punches_time_clock.sql — evidenced non-puncher marker (defect §11)
-- ============================================================================
-- Tucker's ruling 2026-08-24: some employees structurally do not clock in
-- (salaried managers). Left alone they read 0% attendance forever once
-- punches drive the metric — the same class of wrong-number this sprint
-- exists to fix, reintroduced from the other direction.
--
-- ⚠️ THIS FIELD IS DELIBERATELY INGEST-IMMUNE. wage_pay_type cannot carry
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
-- Consumers: computeMetricsFromEntries nulls the attendance/punctuality
-- family when punches_time_clock = false — the employee is EXCLUDED from
-- the denominator (null = not-computable per the wire contracts), never
-- scored zero. Pinned by performance-recompute tests.
--
-- Seed: exactly one employee — Nick Goins (COS), verified live 2026-08-24
-- (38 scheduled days, 0 punches all-time, salaried per Tucker).
--
-- FILE-ONLY until Cowork/Tucker applies via MCP (repo↔prod parity pattern).
-- Additive; safe ahead of the code.
-- ============================================================================

alter table public.employees
  add column if not exists punches_time_clock boolean not null default true;

comment on column public.employees.punches_time_clock is
  'false = evidenced non-puncher (salaried, no clock-ins against a real schedule; SA-confirmed). Excludes the employee from punch-based attendance denominators (null, never 0). SA-set only — deliberately untouched by every ingest and import; NOT derivable from wage_pay_type or title (6 of 7 GMs punch normally).';

update public.employees
set punches_time_clock = false, updated_at = now()
where id = '9303203e-88f2-423f-af56-b4056a6580cc'; -- Nick Goins, COS
