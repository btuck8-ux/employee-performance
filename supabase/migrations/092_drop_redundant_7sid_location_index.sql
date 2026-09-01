-- 092: drop the redundant index added by 088 this same session.
-- employees_location_seven_shifts_user_id_key
--   UNIQUE (location_id, seven_shifts_user_id) WHERE seven_shifts_user_id IS NOT NULL
-- already enforced it (mig 030; referenced in employee-triage/actions.ts as
-- "mig 030's partial unique index"). Two identical unique indexes cost an
-- extra write on every employees insert/update and give the same violation
-- two names. Phase 3's prerequisite P2 was already met before the session.
drop index if exists public.employees_7sid_location_unique;

comment on index public.employees_location_seven_shifts_user_id_key is
  'THE per-store identity key: one EPD code per (7shifts user, location). Multi-store employees intentionally hold one code per store (12 such people live, one with three codes) — never add a unique index on seven_shifts_user_id alone, it would block every multi-store employee.';
