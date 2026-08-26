-- ============================================================================
-- 076_epd_role_unclassified_value.sql — the SIXTH tier value (Tucker's
-- ruling, 2026-08-26, CSU memo §6): "Unclassified is a fine tier value, so
-- long as the UI prompts an admin to take a look so it can be classified as
-- soon as possible."
-- ============================================================================
-- CP shipped this state first (as a null) and holding Pledger/Chianna
-- Taylor rather than guessing is what surfaced it. EPD uses an EXPLICIT
-- value, not a null: employees.epd_role is `not null default`, and there a
-- null cannot distinguish "deliberately unclassified" from "never
-- backfilled" — after a week of "absence is not a signal", encoding a real
-- state as absence would be walking back into it. A CP null and this value
-- mean the same thing; both projects treat them identically.
--
-- VALUE ONLY in this migration: Postgres cannot USE a new enum value in the
-- transaction that adds it, so the default change and the sweep-gate update
-- ride the next migration (077).
-- ============================================================================

alter type public.epd_role add value if not exists 'unclassified';
