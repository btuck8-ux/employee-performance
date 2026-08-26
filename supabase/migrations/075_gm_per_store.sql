-- ============================================================================
-- 075_gm_per_store.sql — GM is a PER-STORE fact (Tucker's reversal,
-- 2026-08-26, relayed in the CSU memo §3). Repo↔prod parity record: the
-- data correction was applied by Cowork the same hour; these guarded
-- updates are no-ops against corrected prod and the record for any rebuild.
-- ============================================================================
-- "Taylor is the GM of FCCSU and Savannah is the GM of FCOL, no need for
--  them to be considered GMs at any other store."
--
-- This REVERSES the person-level framing mig 071's backfill encoded for
-- these rows (071 §3 made EMP-100100 Garrison@FCOL a manager; correct when
-- applied, superseded hours later once CSU's rows existed). The tier
-- describes what someone is AT THAT LOCATION — do not assume one tier per
-- human; a person's rows can carry different tiers at different stores.
-- The wire reads 8 GM rows for 8 humans, exactly one per store; NOLA none,
-- correctly (the position is open).
--
-- ⚠️ RE-APPLY HAZARD ON 071: its guarded seed predates this ruling and
-- would re-promote EMP-100100 if ever re-run. 071 is applied history —
-- never re-run its §3 seed; this file is the current truth for these rows.
--
-- Stored is_general_manager moves in LOCKSTEP with the tier (the mig-071
-- transition doctrine): flag = (epd_role = 'manager') per row, until the
-- column drop lands after partner confirmation.
-- ============================================================================

update public.employees set epd_role = 'user', is_general_manager = false, updated_at = now()
where employee_code = 'EMP-100100' -- Taylor Garrison, FCOL — crew there; GM at FCCSU
  and (epd_role is distinct from 'user' or is_general_manager is distinct from false);

update public.employees set epd_role = 'manager', is_general_manager = true, updated_at = now()
where employee_code = 'EMP-100225' -- Taylor Garrison, FCCSU — the store's GM
  and (epd_role is distinct from 'manager' or is_general_manager is distinct from true);

update public.employees set epd_role = 'user', is_general_manager = false, updated_at = now()
where employee_code = 'EMP-100226' -- Savannah Mallory, FCCSU — crew there; GM at FCOL
  and (epd_role is distinct from 'user' or is_general_manager is distinct from false);

-- EMP-100202 Savannah Mallory @ FCOL stays manager (071 had this one right).

-- The wire-8 gate: exactly 8 manager rows, at most one per store, and the
-- derived flag in lockstep estate-wide — fail the apply on any drift.
do $$
declare bad text; cnt int;
begin
  select count(*) into cnt from public.employees where epd_role = 'manager';
  if cnt <> 8 then
    raise exception 'gm_per_store: % manager rows, expected exactly 8', cnt;
  end if;

  select string_agg(x.location_code, ', ') into bad
  from (
    select l.location_code
    from public.employees e
    join public.locations l on l.id = e.location_id
    where e.epd_role = 'manager'
    group by l.location_code
    having count(*) > 1
  ) x;
  if bad is not null then
    raise exception 'gm_per_store: more than one GM at: %', bad;
  end if;

  select string_agg(employee_code, ', ') into bad
  from public.employees
  where (epd_role = 'manager') is distinct from is_general_manager;
  if bad is not null then
    raise exception 'gm_per_store: flag/tier lockstep drift for: %', bad;
  end if;
end $$;
