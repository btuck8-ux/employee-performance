-- 046_territories_roles
-- Phase A of the RBAC sprint (kickoff-scores-feed-plus-rbac-2026-08-10.md).
-- Introduces the 5-tier role model's schema + the canonical security-definer
-- helpers every later RLS policy and app check reads. No policy on existing
-- data tables changes here (that's Phase B); this migration is additive.
--
-- Role model (LOCKED, Tucker 2026-08-09/10):
--   system_admin   sees everything            grants anything to anyone
--   regional_admin sees a territory           grants area_admin/manager/user in-territory
--                                             (only SA creates regional_admins)
--   area_admin     sees assigned stores       grants manager/user in-stores
--   manager        sees one store             grants nothing, can add users to their store
--   user           sees own metrics only      grants nothing
--
-- Design decision (Code, for Codex review per kickoff §A.1): ONE user_roles
-- table with nullable per-tier scope columns + a per-role CHECK constraint,
-- not per-tier tables. Rationale: (a) the security-definer helpers below stay
-- single-query lookups; (b) "one person, one role" is a primary-key fact, not
-- an application invariant spread over N tables; (c) the grant matrix (Phase C)
-- constrains (granter_role, grantee_role) pairs, which is a row-level CHECK/
-- policy on one table, not a cross-table constraint. The CHECK makes an
-- invalid scope shape unrepresentable, which is what per-tier tables would
-- have bought.
--
-- User-tier linkage: single nullable employee_id (decision 4: email unique-
-- match auto-bind, manual admin link fallback; null = unlinked-pending, sees
-- nothing). Phase B's user-tier policies read this column. A two-store person
-- (two employee rows) is a known open question — if one materializes at
-- onboarding, that's a Tucker decision point (kickoff §return-criteria), not
-- a schema pre-commitment here.

-- ── Territories ──────────────────────────────────────────────────────────────

create table public.territories (
  id         uuid primary key default uuid_generate_v4(),
  key        text not null unique,
  name       text not null,
  created_at timestamptz not null default now()
);

alter table public.territories enable row level security;

-- Territories are reference data: readable by any signed-in user (names show
-- in role UI); writable only via service role (no authenticated write policy).
create policy territories_authenticated_read on public.territories
  for select to authenticated using (true);

insert into public.territories (key, name) values
  ('colorado', 'Colorado'),
  ('nola',     'New Orleans'),
  ('houston',  'Houston');

alter table public.locations add column territory_id uuid references public.territories(id);

-- Mapping verified against live locations 2026-08-09 (kickoff, LOCKED):
-- Colorado = CPD, COS, DTD, FCOL, HRANCH, LONGM · NOLA = NOLA · Houston = HOU.
update public.locations l set territory_id = t.id
from public.territories t
where t.key = case
  when l.location_code in ('CPD','COS','DTD','FCOL','HRANCH','LONGM') then 'colorado'
  when l.location_code = 'NOLA' then 'nola'
  when l.location_code = 'HOU'  then 'houston'
end;

-- Every live location must land in a territory; fail loudly at apply time if a
-- new location_code appeared since the mapping was locked.
do $$
begin
  if exists (select 1 from public.locations where territory_id is null) then
    raise exception 'locations exist with no territory mapping — extend the case list';
  end if;
end $$;

-- ── Roles ────────────────────────────────────────────────────────────────────

create type public.epd_role as enum
  ('system_admin', 'regional_admin', 'area_admin', 'manager', 'user');

create table public.user_roles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  role         public.epd_role not null,
  -- Per-tier scope columns; the CHECK below makes any off-tier shape invalid.
  territory_id uuid references public.territories(id),   -- regional_admin
  location_ids uuid[],                                    -- area_admin (assigned stores)
  location_id  uuid references public.locations(id),      -- manager (one store)
  employee_id  uuid references public.employees(id),      -- user (self-link; null = unlinked-pending)
  granted_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint user_roles_scope_shape check (
    case role
      when 'system_admin'   then territory_id is null and location_ids is null
                                 and location_id is null and employee_id is null
      when 'regional_admin' then territory_id is not null and location_ids is null
                                 and location_id is null and employee_id is null
      -- cardinality, not array_length: array_length('{}') is null, and a
      -- null inside the CASE would make the whole CHECK pass vacuously.
      when 'area_admin'     then territory_id is null and location_ids is not null
                                 and cardinality(location_ids) >= 1
                                 and location_id is null and employee_id is null
      when 'manager'        then territory_id is null and location_ids is null
                                 and location_id is not null and employee_id is null
      when 'user'           then territory_id is null and location_ids is null
                                 and location_id is null
    end
  )
);

alter table public.user_roles enable row level security;

-- ── Canonical helpers (security definer) ────────────────────────────────────
-- Every RLS policy (Phase B) AND every app-side check calls these — the app
-- derives visibility from the SAME SQL source of truth, never a parallel TS
-- reimplementation (TS↔SQL lockstep rule). security definer lets them read
-- user_roles under RLS without recursive policy evaluation; search_path is
-- pinned per Supabase guidance.
--
-- All helpers are bound to auth.uid() internally — none accepts a uid
-- parameter (Codex Phase A finding: parameterized helpers granted to
-- `authenticated` would let any signed-in user probe another user's role and
-- scope by UUID, bypassing the user_roles self-read policy). Callers only
-- ever ask about themselves; the Phase C role UI reads user_roles directly
-- under its own RLS instead.
-- STABLE (not volatile) deliberately: per-statement snapshot semantics are
-- correct for authorization predicates and let the planner cache the lookup
-- across rows within a statement.

create or replace function public.epd_user_role()
returns public.epd_role
language sql stable security definer set search_path = public
as $$
  select role from public.user_roles where user_id = auth.uid();
$$;

create or replace function public.epd_is_system_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(public.epd_user_role() = 'system_admin', false);
$$;

-- Location grain: which locations' rows may the calling user read?
-- system_admin: every location. regional_admin: their territory's locations.
-- area_admin: assigned stores. manager: their store. user: none — user-tier
-- visibility is employee-grain (epd_can_read_employee), not location-grain.
create or replace function public.epd_authorized_location_ids()
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select case ur.role
    when 'system_admin'   then (select coalesce(array_agg(id), '{}') from public.locations)
    when 'regional_admin' then (select coalesce(array_agg(id), '{}') from public.locations
                                where territory_id = ur.territory_id)
    when 'area_admin'     then coalesce(ur.location_ids, '{}')
    when 'manager'        then array[ur.location_id]
    else '{}'::uuid[]
  end
  from public.user_roles ur where ur.user_id = auth.uid();
$$;

-- Employee grain: may the calling user read rows about (employee, location)?
-- The single predicate Phase B policies and app routes share. Row-level only —
-- pay fields ride along by decision 2 (no column masking).
create or replace function public.epd_can_read_employee(emp_id uuid, loc_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    when public.epd_user_role() = 'user'
      then exists (select 1 from public.user_roles ur
                   where ur.user_id = auth.uid() and ur.employee_id is not null
                     and ur.employee_id = emp_id)
    else loc_id = any (coalesce(public.epd_authorized_location_ids(), '{}'))
  end;
$$;

-- Helpers are callable by signed-in users (and their RLS policies);
-- revoke from anon out of caution.
revoke execute on function public.epd_user_role(),
                          public.epd_is_system_admin(),
                          public.epd_authorized_location_ids(),
                          public.epd_can_read_employee(uuid, uuid) from public, anon;
grant execute on function public.epd_user_role(),
                          public.epd_is_system_admin(),
                          public.epd_authorized_location_ids(),
                          public.epd_can_read_employee(uuid, uuid)
  to authenticated, service_role;

-- ── location_ids element integrity ──────────────────────────────────────────
-- Postgres cannot FK-enforce array elements; this trigger closes the gap
-- (Codex Phase A finding): no nulls, no duplicates, every element a real
-- location. Writes are SA-only regardless — this guards data quality, not
-- privilege.

create or replace function public.user_roles_validate_location_ids()
returns trigger
language plpgsql
as $$
begin
  if new.location_ids is not null then
    if exists (select 1 from unnest(new.location_ids) x where x is null) then
      raise exception 'location_ids may not contain null elements';
    end if;
    if (select count(distinct x) from unnest(new.location_ids) x)
       <> cardinality(new.location_ids) then
      raise exception 'location_ids may not contain duplicates';
    end if;
    if exists (
      select 1 from unnest(new.location_ids) x
      left join public.locations l on l.id = x
      where l.id is null
    ) then
      raise exception 'location_ids contains an unknown location id';
    end if;
  end if;
  return new;
end;
$$;

create trigger user_roles_location_ids_check
  before insert or update on public.user_roles
  for each row execute function public.user_roles_validate_location_ids();

-- ── user_roles policies ─────────────────────────────────────────────────────
-- Reads: your own row, or any row if system_admin (role UI needs the roster —
-- broader grant-matrix reads/writes arrive with the Phase C role UI).
-- Writes: system_admin only (decision 3: all mutating surfaces SA-only this
-- sprint); the service role bypasses RLS for operational paths.

create policy user_roles_self_read on public.user_roles
  for select to authenticated
  using (user_id = auth.uid() or public.epd_is_system_admin());

create policy user_roles_sa_write on public.user_roles
  for all to authenticated
  using (public.epd_is_system_admin())
  with check (public.epd_is_system_admin());

-- ── Seed ────────────────────────────────────────────────────────────────────
-- auth.users = exactly Tucker's 2 accounts (verified live 2026-08-09, kickoff
-- "before" picture). Guard: only seed while user_roles is empty, so a re-apply
-- or a later environment can never silently mint extra system_admins.

insert into public.user_roles (user_id, role)
select u.id, 'system_admin'::public.epd_role
from auth.users u
where not exists (select 1 from public.user_roles);
