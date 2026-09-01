-- 088: per-store identity unique index. APPLIED to prod 2026-08-31, then
-- DROPPED the same session by mig 092 — it was REDUNDANT.
-- employees_location_seven_shifts_user_id_key has enforced the identical
-- constraint since mig 030, with the columns in the other order (irrelevant
-- to uniqueness). Kept as a file only for parity with prod's migration list;
-- do not re-apply. See 092.
create unique index if not exists employees_7sid_location_unique
  on public.employees (seven_shifts_user_id, location_id)
  where seven_shifts_user_id is not null;
