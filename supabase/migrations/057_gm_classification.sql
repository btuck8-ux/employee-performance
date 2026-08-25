-- ============================================================================
-- 057_gm_classification.sql — GM classification (visibility, NOT exclusion)
-- ============================================================================
-- Tucker's ruling 2026-08-24 (flip spec §1): classify GMs; keep them in
-- store-wide attendance and punctuality for now.
--
-- ⚠️ THIS FLAG MUST NOT CHANGE ANY COMPUTED METRIC. It is a display and
-- reporting dimension only (pinned by test: is_general_manager never
-- appears in performance-recompute.ts or any metric path). Its jobs:
--   1. Label GMs on employee lists, the profile, and the crosswalk surface,
--      with a note that GM punch patterns are expected to be irregular
--      (offsite work, on-call time that never reaches a time clock).
--   2. Report store-wide attendance/punctuality BOTH ways — all staff and
--      excluding management — side by side. Neither is "the" number.
--      ⚠️ The store card SHIPS WITH THE FLIP PR, not this one: computed
--      from time_entries it reads 73.1% at CPD against an actual 97.3%
--      (72.0% vs 94.7% at DTD). It must read scheduled shifts from
--      seven_shifts_shifts (pruned) and punches from toast_time_entries —
--      the same sources the flip gives the metrics — or the store card
--      and the employees inside it disagree.
--
-- Why exclusion is deliberately NOT implemented (measured 2026-07-01 →
-- 08-20, summed numerators, never averaged): the two large excl-GM effects
-- (COS +9.8pp, CPD +11.4pp) are the Toast defect — both GMs reading 0%,
-- one with 37 recovered punches waiting on the flip. At DTD and HRANCH the
-- GM is the best attender in the building, so excluding them makes the
-- store look WORSE (−2.2pp / −1.2pp). Re-measure after the flip; exclude
-- later on evidence if the effect survives ("back pocket" — Tucker).
--
-- ⚠️ INGEST-IMMUNE for the same reason as mig 056: the employee CSV upload
-- clobbers wage_pay_type, so no ingest/import/matcher may touch this field.
-- Writers: this migration's seed and the SA employee-edit surface only.
-- Do NOT derive from title or pay type.
--
-- Seed: exactly the eight GMs named by Tucker 2026-08-24. Guarded (the
-- mig 056 pattern) so re-applies are no-ops and a later SA change is never
-- reverted by a repeated manual run.
--
-- Note for later readers — Jose Mena (HOU): auto-matched at a 39-minute
-- median, the loosest of the 34 auto-matches, now explained: a GM clocking
-- in irregularly. Independently re-ranked he sits at 43.3 min against the
-- next candidate's 120. Not a weak match.
--
-- FILE-ONLY until Cowork/Tucker applies via MCP (repo↔prod parity pattern).
-- Additive; safe ahead of the code.
-- ============================================================================

alter table public.employees
  add column if not exists is_general_manager boolean not null default false;

comment on column public.employees.is_general_manager is
  'General-manager classification (Tucker 2026-08-24). Display/reporting dimension ONLY — must never change a computed metric (GMs stay in store-wide attendance/punctuality; exclusion is reported side-by-side, not applied). SA-set only; ingest-immune; never derived from title or pay type.';

update public.employees set is_general_manager = true, updated_at = now()
where id = '9303203e-88f2-423f-af56-b4056a6580cc' -- Nick Goins, COS
  and is_general_manager is distinct from true;

update public.employees set is_general_manager = true, updated_at = now()
where id = '6bf6c651-d0bf-4c5b-8bbf-d2da73ade9e3' -- Luke Cato, CPD
  and is_general_manager is distinct from true;

update public.employees set is_general_manager = true, updated_at = now()
where id = 'f2127628-3636-407d-a0e2-dbe7c0d3e9f0' -- Seth Rexroad, DTD
  and is_general_manager is distinct from true;

update public.employees set is_general_manager = true, updated_at = now()
where id = '61712c3d-b8bc-4bed-9f29-35f299bdd92c' -- Savannah Mallory, FCOL
  and is_general_manager is distinct from true;

update public.employees set is_general_manager = true, updated_at = now()
where id = '42d4817c-77b3-4634-9715-ff591e158e78' -- Taylor Garrison, FCOL (CSU)
  and is_general_manager is distinct from true;

update public.employees set is_general_manager = true, updated_at = now()
where id = 'eb3ae1aa-568f-4f73-b212-43d69280c636' -- Jose Mena, HOU
  and is_general_manager is distinct from true;

update public.employees set is_general_manager = true, updated_at = now()
where id = '0b27015d-b8c9-48da-9eaf-b7eca416177f' -- Liv Sandifer, HRANCH
  and is_general_manager is distinct from true;

update public.employees set is_general_manager = true, updated_at = now()
where id = '684c613b-8b94-4994-a256-bfbe2ca6110e' -- Jaime Hernandez, LONGM
  and is_general_manager is distinct from true;
