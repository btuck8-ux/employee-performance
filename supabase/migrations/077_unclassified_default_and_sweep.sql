-- ============================================================================
-- 077_unclassified_default_and_sweep.sql — unclassified becomes the default
-- for NEW employees, and it is NOT sweep-exempt (CSU memo §6, both ruled).
-- ============================================================================
-- DEFAULT: with the old default at 'user', every import silently asserted a
-- tier nobody chose — the "looked authoritative, never actually decided"
-- failure this week produced four times, built into a column default. New
-- rows now land unclassified until a human classifies them (the admin
-- surface applies the steady pressure). EXISTING rows keep their values:
-- this changes what an import asserts going forward, it re-judges nobody.
--
-- ⚠️ THE TRAP THIS GUARDS (CP's rule, adopted and pinned): the departure
-- sweep gates on role_is_sweepable(). Omit 'unclassified' and the one
-- population nobody has looked at becomes the one population the notifier
-- cannot see — exactly backwards. Unclassified is NOT exempt: unclassified
-- and user flag normally; only area_admin and above are immune.
-- ============================================================================

alter table public.employees
  alter column epd_role set default 'unclassified';

create or replace function public.role_is_sweepable(r public.epd_role)
returns boolean language sql immutable as $$
  select r in ('user','manager','unclassified')
$$;

comment on column public.employees.epd_role is
  'EMPLOYMENT/user tier — what this person IS at THIS location (PER-STORE, '
  'Tucker 2026-08-26: a person''s rows can carry different tiers at '
  'different stores; do not assume one tier per human). Six shared values '
  'since the CSU memo: system_admin | regional_admin | area_admin | manager '
  '| user | unclassified. unclassified = no human has decided yet — NOT '
  'sweep-exempt, surfaced for classification on the admin UI. Default for '
  'new rows. NOT the same axis as users.role (legacy app permission). '
  'Store/schedule roles (shift lead, AGM) live in Toast/7shifts.';

comment on function public.role_is_sweepable(public.epd_role) is
  'Departure-sweep tier gate: user, manager, AND unclassified sweep '
  '(unclassified is NOT exempt — CP''s rule, CSU memo §6); area_admin and '
  'above are immune until a human acts.';

-- user_roles is a LOGIN-grant table; 'unclassified' is a roster state, not
-- a grantable app role — and the mig-046 scope-shape CHECK's CASE has no
-- branch for it, so it would pass VACUOUSLY (NULL result — the exact
-- null-in-CASE hazard 046 documented for array_length). Reject explicitly.
alter table public.user_roles
  drop constraint if exists user_roles_role_not_unclassified;
alter table public.user_roles
  add constraint user_roles_role_not_unclassified
  check (role <> 'unclassified');
