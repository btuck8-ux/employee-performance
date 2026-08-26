-- ============================================================================
-- 078_sweepable_ordinal.sql — the sweep gate becomes an ORDERING, not a
-- list (denominator spec rev 2 §7c, Tucker 2026-08-26: "the dormant sweep
-- should exclude all roles that are higher than manager").
-- ============================================================================
-- BEHAVIOUR-PRESERVING today: epd_role's declaration order is
-- system_admin < regional_admin < area_admin < manager < user <
-- unclassified, so `r >= 'manager'` returns exactly what the allow-list
-- did. What changes is the FAILURE MODE for the seventh value nobody has
-- added yet: an allow-list defaults a new value to immune (silent — the
-- population nobody looked at becomes the one the notifier cannot see, the
-- trap 'unclassified' nearly fell into); the ordering defaults a
-- below-manager value to swept (a false notification an operator
-- dismisses). Choose the failure that is visible. Pinned by a
-- TABLE-DRIVEN test (one case per enum value, coverage-asserted) — a
-- seventh value fails the build until a human decides which side it
-- falls on, and its INSERT POSITION in the enum is that decision.
--
-- ⛔ WHERE THE GATE MUST BE (the incident this hardens against): Aleef
-- Shehadeh EMP-100000 and Keeno Suave EMP-100187 — both regional_admin,
-- both correctly immune per this function — were archived at
-- 2026-08-26 04:53:47 by a hand-written SQL batch that never called it
-- (restored; snapshot restored_regional_admins_20260826). A rule enforced
-- by a function is only enforced where the function is called. The app's
-- deactivation paths now gate on this function; HAND-WRITTEN ARCHIVAL
-- BATCHES ARE REQUIRED TO FILTER ON role_is_sweepable(epd_role) — no
-- exceptions, that requirement is this comment.
-- ============================================================================

create or replace function public.role_is_sweepable(r public.epd_role)
returns boolean language sql immutable as $$
  -- Tucker 2026-08-26: everything ABOVE manager is immune. Written as an
  -- ordinal comparison against the enum, not an allow-list, so the rule
  -- survives the next value added to epd_role.
  select r >= 'manager'::public.epd_role
$$;

comment on function public.role_is_sweepable(public.epd_role) is
  'Deactivation/sweep tier gate (ordinal, mig 078): everything ABOVE '
  'manager in epd_role''s declaration order is immune; manager, user and '
  'unclassified sweep (unclassified is NOT exempt — CP''s rule). Every '
  'bulk deactivation — the departure sweep, admin actions, imports, and '
  'HAND-WRITTEN SQL BATCHES — must filter on this function; the 2026-08-26 '
  'regional-admin incident is what happens when one does not.';
