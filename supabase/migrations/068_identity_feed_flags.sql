-- 068: identity feed gains punches_time_clock + is_general_manager
-- (demarcation spec 2026-08-26 §1h).
--
-- EPD told CulturePulse that any punch-evidence departure signal must
-- exclude evidenced non-punchers and GMs — then served an identity feed
-- carrying neither flag. "Do not hand a partner a rule you have not
-- verified you can support" (§9). Both are non-sensitive employment
-- attributes already exposed to managers; the wage/tip security ruling
-- does not restrict them.
--
-- Additive append: the two columns land AFTER the existing eight, nothing
-- reordered, renamed, or removed — the same motion as every feed change
-- this project has shipped. The route serves select("*"), so the wire
-- gains the keys on deploy of nothing: views are DB-side.
-- security_invoker carried over verbatim (037).

create or replace view public.v_employee_identity
with (security_invoker = true) as
select
  e.employee_code        as employee_code,   -- PRIMARY join key (unique, durable, per-location)
  e.employee_name        as employee_name,   -- match fallback + rename propagation
  l.location_code        as location_code,   -- shared code (CPD...), NOT location_key
  e.seven_shifts_user_id as seven_shifts_user_id, -- CP's PRIMARY directory-match key
  e.email                as email,           -- match fallback
  e.active               as active,          -- route filters active-only by default
  e.archived_at          as archived_at,     -- status signal; CP never nulls a code
  e.updated_at           as updated_at,      -- drives incremental ?since pulls (set by trg_employees_updated)
  -- §1h (2026-08-26): the two exclusion flags partners were asked to
  -- honour but could not evaluate. Appended, never reordered.
  e.punches_time_clock   as punches_time_clock,   -- false = evidenced non-puncher (mig 056)
  e.is_general_manager   as is_general_manager    -- mig 057 classification
from public.employees e
join public.locations l on l.id = e.location_id;
