-- 037_v_employee_identity
-- Backing view for the EPD->Culture Pulse IDENTITY feed (GET /api/identity).
-- Per spec-epd-cp-identity-sync-2026-07-20.md (authoritative).
--
-- Purpose: let CP auto-populate employee_directory.employee_code from EPD without
-- the manual per-new-hire hop. The scores feed (v_employee_scores, 028) CANNOT do
-- this: it joins performance_records WHERE e.active, so a codeable-but-unscored NEW
-- HIRE never appears, and it doesn't expose seven_shifts_user_id. This view is
-- sourced straight from `employees`, so every minted employee shows up the moment
-- their code exists.
--
-- LOCKED keys: employee_code = PRIMARY join key; location_code (CPD...), NOT location_key.
--   seven_shifts_user_id = CP's primary directory-match key; email/name are fallbacks.
--   employee_code is per-location -- a person at 2 stores has 2 codes / 2 rows here
--   (one row per (employee, location)), matching the v_employee_scores grain.
--
-- No `active` filter here (unlike 028): the /api/identity route decides active-only
--   vs include_inactive, so the view exposes `active` + `archived_at` and returns the
--   full roster.
-- security_invoker=true: the route queries via the service role (bypasses RLS);
--   invoker semantics keep the view from leaking rows to lower-privilege roles (as 028/029).
-- Additive: read-only view; no change to any table or to the scores views.
-- APPLIED TO PROD via Supabase MCP on 2026-07-20 (Cowork). Committed for parity.

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
  e.updated_at           as updated_at       -- drives incremental ?since pulls (set by trg_employees_updated)
from public.employees e
join public.locations l on l.id = e.location_id;
