-- ============================================================================
-- 071_epd_role_authoritative.sql — employees.epd_role is the authoritative
-- user tier (spec 2026-08-26; supersedes the 05:xx employment_tier draft)
-- ============================================================================
-- Tucker's rulings this implements:
--   * "Crew, shift-leads, assistant GMs and team leads are indistinguishable
--     from a USER-TYPE perspective … their USER-TYPE consolidates down to
--     just 'user'." Store/schedule roles (shift lead, AGM, team lead — and
--     CASHIER/SEXY) stay in Toast/7shifts; EPD NEVER parses a vendor role
--     string and builds NO mapping table. GM designation is human-set.
--   * "Option B — make employees.epd_role authoritative. Aleef sits as a
--     Regional Admin."
--
-- ⛔ §1 LOCKOUT GUARD — "authoritative" is scoped to people IN the estate:
--     user_roles.employee_id IS NOT NULL → role derives from employees.epd_role
--     user_roles.employee_id IS NULL     → user_roles.role stands on its own
--   All three live logins (2 system_admin + 1 regional_admin) carry
--   employee_id NULL and NO employee row — a strict reading of
--   "authoritative" would resolve every one of them to no role, a total
--   lockout. Do NOT "fix" that by minting employee rows for logins:
--   service/non-person accounts must not sit on the roster (the CAKE
--   Support problem, ruled hours before this spec).
--
-- ⚠️ KNOWN CONSTRAINT, deliberate (Tucker's ruling on PR #42 deviation 3):
--   because employees.epd_role WINS over user_roles.role, an employee-
--   backed login can NEVER hold app access above its employment tier.
--   Example: granting Taylor Garrison area_admin visibility across FCOL +
--   FCCSU would require changing her EMPLOYMENT tier — which would make
--   her sweep-immune and misdescribe her job. That is the consequence of
--   unifying the axes, not a defect. If elevated app access for a working
--   employee is ever needed, that is a Tucker decision about the model,
--   not a workaround to build here.
--
-- ⚠️ NAMING HAZARD (say it or someone wires the wrong table): 'manager' on
--   employees.epd_role means GENERAL MANAGER (employment tier). 'manager'
--   also exists in users.role (admin|manager|viewer), where it is a legacy
--   app permission. Two tables, one word, different meanings. The derived
--   wire field reads the EMPLOYMENT one. users.role is untouched here —
--   auth changes do not get bundled with a roster change.
--
-- Reuses the existing public.epd_role enum (mig 046). No new type.
-- is_general_manager is NOT dropped here: CP is mid-sprint against it and
-- THQ's gates expect it. The truth moves (epd_role); the wire field is
-- derived in v_employee_identity. Drop comes in a LATER migration only
-- after both partners confirm.
--
-- FILE-ONLY until applied via MCP (repo↔prod parity pattern).
-- ============================================================================

-- ── 1. The tier column ──────────────────────────────────────────────────────

alter table public.employees
  add column if not exists epd_role public.epd_role not null default 'user';

comment on column public.employees.epd_role is
  'EMPLOYMENT/user tier — what this person IS in the estate. Authoritative for '
  'anyone with an employee row. NOT the same axis as users.role (legacy app '
  'permission). Store/schedule roles (shift lead, AGM, team lead) live in '
  'Toast/7shifts and are deliberately NOT represented here.';

-- ── 2. Sweep immunity, expressed once ───────────────────────────────────────
-- The immunity line sits ABOVE GM, not at it: a GM who stops working is a
-- real departure; a regional admin having no shifts is their normal state.

create or replace function public.role_is_sweepable(r public.epd_role)
returns boolean language sql immutable as $$
  select r in ('user','manager')
$$;

revoke execute on function public.role_is_sweepable(public.epd_role)
  from public, anon;
grant execute on function public.role_is_sweepable(public.epd_role)
  to authenticated, service_role;

-- ── 3. Backfill ─────────────────────────────────────────────────────────────
-- Default 'user' covers all rows (incl. the five archived service/junk rows —
-- a service_account tier was proposed and DENIED; if one is ever un-archived
-- it becomes sweepable, the right outcome for a junk row). Explicit rows
-- below carry their employee_code — THQ's hard precondition after the
-- three-Turners incident: a memo naming a person for a write op carries the
-- code or it is not sendable. Same rule here. Guarded (mig 056/057 pattern)
-- so re-applies are no-ops and a later SA change is never reverted.
-- Archived rows get real roles too: an un-archived GM returns as a GM, not
-- as crew. NOLA deliberately has NO manager row — "NOLA has no GM right
-- now — so no GM in either system is accurate" (Tucker, 2026-08-26); Davida
-- Turner and Joani Barron stay 'user'. Do not infer roles from email
-- patterns (ikesofhouston@ is Aleef and carries no manager token).

-- Fail loudly if any named code is missing — a typo here must never
-- silently skip a ruled assignment.
do $$
declare missing text;
begin
  select string_agg(c.code, ', ') into missing
  from unnest(array[
    'EMP-100000','EMP-100187',                                    -- regional_admin
    'EMP-100051','EMP-100020','EMP-100088','EMP-100202',          -- manager
    'EMP-100100','EMP-100007','EMP-100148','EMP-100159'           -- manager
  ]) as c(code)
  where not exists (select 1 from public.employees e where e.employee_code = c.code);
  if missing is not null then
    raise exception 'epd_role backfill: named employee_codes not found: %', missing;
  end if;
end $$;

update public.employees set epd_role = 'regional_admin', updated_at = now()
where employee_code = 'EMP-100000' -- Aleef Shehadeh, HOU — ruled by Tucker
  and epd_role is distinct from 'regional_admin';

update public.employees set epd_role = 'regional_admin', updated_at = now()
where employee_code = 'EMP-100187' -- Keeno Suave, NOLA — ruled via CP
  and epd_role is distinct from 'regional_admin';

update public.employees set epd_role = 'manager', updated_at = now()
where employee_code in (
  'EMP-100051', -- Nick Goins, COS
  'EMP-100020', -- Luke Cato, CPD
  'EMP-100088', -- Seth Rexroad, DTD
  'EMP-100202', -- Savannah Mallory, FCOL
  'EMP-100100', -- Taylor Garrison, FCOL (FCCSU's GM; keeps FCOL by accumulation)
  'EMP-100007', -- Jose Mena, HOU
  'EMP-100148', -- Liv Sandifer, HRANCH
  'EMP-100159'  -- Jaime Hernandez, LONGM
) and epd_role is distinct from 'manager';

-- Wire-safety gate: the derived is_general_manager below must return the
-- SAME rows the stored flag returns today, or the feed changes shape-of-
-- truth silently. Any mismatch (e.g. a GM flagged since this spec was cut)
-- is a Tucker decision, never a silent pick — fail the apply.
do $$
declare bad text;
begin
  select string_agg(employee_code, ', ') into bad
  from public.employees
  where (epd_role = 'manager') is distinct from is_general_manager;
  if bad is not null then
    raise exception
      'epd_role backfill: derived is_general_manager would differ from the stored flag for: % — resolve with Tucker before applying', bad;
  end if;
end $$;

-- ── 4. is_general_manager becomes derived; epd_role joins the feed ─────────
-- Wire field unchanged: same name, same type, same semantics — only where
-- the truth lives moves. epd_role is APPENDED as column 11 (additive-only,
-- the same motion as every feed change this project has shipped): partners
-- adopt the shared five-value vocabulary off the wire, never before they
-- can read it. Route serves select("*"), so the wire gains the key on view
-- apply. security_invoker carried over verbatim (037/068).

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
  e.punches_time_clock   as punches_time_clock,   -- false = evidenced non-puncher (mig 056)
  -- 071: DERIVED from the authoritative tier. 'manager' here means GENERAL
  -- MANAGER (employees.epd_role axis) — never users.role's 'manager'.
  (e.epd_role = 'manager') as is_general_manager,
  -- 071: the shared five-value vocabulary, appended, never reordered.
  e.epd_role             as epd_role
from public.employees e
join public.locations l on l.id = e.location_id;

-- ── 5. Role resolution derives from the roster (§1) ─────────────────────────
-- employee-backed login → tier comes from employees.epd_role (one truth per
-- person). Login with no staff record → its own grant stands. All three
-- live logins are the second shape; their resolution is UNCHANGED by this
-- migration (verification gate: test before deploy, not after).

create or replace function public.epd_user_role()
returns public.epd_role
language sql stable security definer set search_path = public
as $$
  select coalesce(e.epd_role, ur.role)
  from public.user_roles ur
  left join public.employees e on e.id = ur.employee_id
  where ur.user_id = auth.uid();
$$;

-- Scope for a DERIVED tier follows the person's store, because an
-- employee-backed row's own scope columns are necessarily NULL (the
-- user_roles_scope_shape CHECK only lets role='user' rows carry
-- employee_id): derived manager/area_admin → their store; derived
-- regional_admin → their store's territory (Aleef, HOU → houston — exactly
-- the ruled shape); derived system_admin → everything. Non-derived logins
-- resolve precisely as before. NOTE: no live row exercises the derived
-- path today (all three logins are un-backed); this is the boundary
-- working, not a behavior change.

create or replace function public.epd_authorized_location_ids()
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select case coalesce(e.epd_role, ur.role)
    when 'system_admin'   then (select coalesce(array_agg(id), '{}') from public.locations)
    when 'regional_admin' then (select coalesce(array_agg(l.id), '{}') from public.locations l
                                where l.territory_id = coalesce(el.territory_id, ur.territory_id))
    when 'area_admin'     then coalesce(
                                 case when e.id is not null then array[e.location_id] end,
                                 ur.location_ids, '{}')
    when 'manager'        then case when e.id is not null
                                 then array[e.location_id]
                                 else array[ur.location_id] end
    else '{}'::uuid[]
  end
  from public.user_roles ur
  left join public.employees e on e.id = ur.employee_id
  left join public.locations el on el.id = e.location_id
  where ur.user_id = auth.uid();
$$;

-- epd_is_system_admin / epd_can_read_employee / epd_self_employee_id compose
-- on the two helpers above and need no change: an employee-backed row keeps
-- ur.role='user' (scope-shape CHECK), so epd_self_employee_id still returns
-- its employee_id and self-visibility survives the derivation.
