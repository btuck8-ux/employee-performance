-- 050_client_admins_helper
-- RBAC Phase C, clients + invites (kickoff-ui-rbac-c-brand-2026-08-14.md §4).
-- One security-definer helper that exposes each client group's managing
-- Regional Admins — with email + pending-invite state from auth.users — to
-- authorized viewers. No policy changes, no new tables: RA-per-client rides
-- the existing territory model (clients ↔ territories are 1:1 today via
-- locations.client_id / locations.territory_id; a client may have N ≥ 0 RAs).
--
-- Why a helper and not a view/RLS grant: the emails live in auth.users, which
-- PostgREST does not expose and which authenticated must never read wholesale.
-- The helper is the 046 pattern — zero-arg, caller-bound via auth.uid(),
-- security definer with pinned search_path, internally gated:
--   system_admin    → every client's RA rows
--   regional_admin  → only rows for their own territory's client
--   everyone else   → zero rows (fail closed)
--
-- Follows every 046/047 convention. (No array-returning helper appears in a
-- policy here, so the `::uuid[]` cast idiom doesn't arise — noted per the
-- kickoff's 🚨.)
--
-- Apply via Cowork/Tucker MCP AFTER Codex review, BEFORE the PR merges; this
-- file is the parity copy (repo↔prod pattern).

create or replace function public.epd_list_client_admins()
returns table (
  client_id       uuid,
  user_id         uuid,
  email           text,
  display_name    text,
  invited_pending boolean
)
language sql stable security definer set search_path = public
as $$
  select
    ct.client_id,
    ur.user_id,
    u.email::text,
    coalesce(
      u.raw_user_meta_data ->> 'full_name',
      u.raw_user_meta_data ->> 'name'
    ) as display_name,
    -- Pending until the account's first sign-in (invite accepted or first
    -- Google OAuth sign-in, whichever lands first).
    (u.last_sign_in_at is null) as invited_pending
  from public.user_roles ur
  join (
    -- territory → client bridge: distinct pairs from locations (1:1 today;
    -- N locations per client collapse to one pair per territory).
    select distinct l.client_id, l.territory_id
    from public.locations l
    where l.client_id is not null and l.territory_id is not null
  ) ct on ct.territory_id = ur.territory_id
  join auth.users u on u.id = ur.user_id
  where ur.role = 'regional_admin'
    and (
      public.epd_is_system_admin()
      or (
        public.epd_user_role() = 'regional_admin'
        and ur.territory_id = (
          select r.territory_id from public.user_roles r
          where r.user_id = auth.uid()
        )
      )
    );
$$;

revoke execute on function public.epd_list_client_admins() from public, anon;
grant execute on function public.epd_list_client_admins()
  to authenticated, service_role;
