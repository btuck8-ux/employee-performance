-- ============================================================================
-- 061_actuals_source_toast.sql — THE FLIP: the seven Toast stores' actuals
-- source becomes Toast (flip spec 2026-08-24 §3, preconditions cleared
-- 2026-08-25: crosswalk queue worked incl. the HRANCH Evans pair, audit at
-- 0 flags estate-wide, punch estate re-backfilled from each store's go-live)
-- ============================================================================
-- WHAT FLIPS. Setting actuals_source='toast' stops the nightly 7shifts
-- worked-time ingest at these stores (sevenshifts/orchestrator.ts gates its
-- 7shifts_time block on === '7shifts'), and the TS recompute paths (same
-- PR) switch to the flip sources: worked = toast_time_entries with the
-- go-live split (mirroring v_worked_intervals exactly — TS↔SQL parity),
-- scheduled = seven_shifts_shifts pruned, store+day-conditional (a day
-- with no direct-feed rows for the store falls back to time_entries
-- scheduled — the day-conditional method rule: a cutover predicate depends
-- on the replacement being PRESENT, never on a date alone).
--
-- WHY THE 2026-07-27 AUDIT'S "NAIVE FLIP KILLS CO LABOR" NO LONGER APPLIES.
-- That audit's point: consumers read time_entries, so flipping the source
-- without moving the consumers starves them. Every consumer has now moved
-- or is accounted for (the reader sweep in PR #33 lists each one):
--   * tips/presence/hours (SQL): v_worked_intervals + v_sales_effective
--     (migs 058/060) — source-switched.
--   * attendance/punctuality (TS): the recompute entry points, profile
--     summaries, multi-location combiner, and the store card read the
--     flip sources via flip-entries.ts (this PR).
--   * actuals_source readers: orchestrator (the intended gate),
--     coverage/backfill-worked-time/backfill-roles/hire-date-probe — all
--     compare against '7shifts' and correctly treat 'toast' stores as
--     not-7shifts.
--
-- ⚠️ ACCEPTED CONSEQUENCES, stated loudly (both in PR #33's sweep):
--   1. KITCHEN SPEED attribution freezes at flip time for new dates at
--      these stores: compute_kitchen_speed matches on time_entries.role,
--      and worked time_entries stop accruing here. Known limitation
--      (058's header): closing it needs the Toast jobReference→role
--      mapping. The PDF is Kitchen Speed's only surface.
--   2. HIRE-DATE FILL (§6-B: earliest WORKED time_entries row) will not
--      see new hires at these stores post-flip — their worked evidence
--      lands in toast_time_entries. Extending §6-B to Toast punches is a
--      flagged Tucker decision (same semantic, different table), NOT
--      silently changed here.
--   3. CP-schedule ingest keeps writing time_entries scheduled rows at
--      these stores; harmless — the denominator prefers the direct feed
--      wherever it has rows for the store+day, and those rows remain the
--      pre-June-2026 history fallback.
--
-- NOLA stays 'cake' — excluded from the flip throughout (spec §4).
--
-- ⚠️ FILE-ONLY until Cowork/Tucker applies via MCP. Apply order:
-- 058 → 059 → 060 → 061, all WITH this PR's code deploy; the Houston
-- Toast sales backfill runs FIRST (PR #33's operator sequence). This
-- migration + the recompute switch move published attendance/punctuality
-- numbers — the §5 verification (before/after per store, >10-point movers
-- named, nulls with reasons, the residual triage list, frozen-quarter
-- confirmation) runs immediately after.
-- ============================================================================

alter table public.locations
  drop constraint if exists locations_actuals_source_check;
alter table public.locations
  add constraint locations_actuals_source_check
  check (actuals_source in ('7shifts', 'cake', 'toast'));

comment on column public.locations.actuals_source is
  'Worked-actuals routing: 7shifts (time_entries via the nightly fan-out) | cake (NOLA, the cake-nightly Action) | toast (the seven Toast stores since the 2026-08 flip — punches in toast_time_entries, scheduled denominator from seven_shifts_shifts; time_entries holds their pre-go-live history only).';

-- Guarded seeds (the established pattern): re-applies are no-ops. Exactly
-- the seven Toast stores; NOLA is deliberately absent.
update public.locations set actuals_source = 'toast', updated_at = now()
 where location_code in ('CPD', 'COS', 'DTD', 'FCOL', 'HRANCH', 'LONGM', 'HOU')
   and actuals_source is distinct from 'toast';

-- flip-entries.ts (TS) and the SQL views read store config through
-- v_location_flip_config (definer-rights, three config columns — the 058
-- pattern for user-tier safety). Make its read grant explicit rather than
-- relying on default privileges: the profile page runs under the SESSION
-- client, and a user-tier viewer must be able to resolve their own store's
-- flip config or their profile summaries silently misroute.
grant select on public.v_location_flip_config to authenticated;

-- ----------------------------------------------------------------------------
-- v_direct_feed_days — store-day coverage of the pruned direct feed, as a
-- DEFINER-rights view (the v_location_flip_config pattern; expect the
-- advisor flag — deliberate).
--
-- ⚠️ WHY DEFINER: flip-entries' day-conditional scheduled fallback needs
-- the STORE-level covered-day set. seven_shifts_shifts_read is Class-1
-- (purview OR self), so a user-tier session sees only its OWN shift rows —
-- the store's covered days would collapse to "days I am scheduled", and
-- covered days without the viewer's shift would wrongly fall back to their
-- unpruned time_entries artifact rows (a phantom missed day on their own
-- profile). This view exposes exactly (location_id, entry_date) — no
-- employee data, no times; row protection for actual shift rows stays on
-- the base table (Codex blocker, 2026-08-25).
-- ----------------------------------------------------------------------------
create or replace view public.v_direct_feed_days as
select distinct location_id, entry_date
from public.seven_shifts_shifts
where missing_upstream_since is null
  and deleted = false
  and draft = false;

comment on view public.v_direct_feed_days is
  'DELIBERATELY definer-rights: the pruned direct feed''s store-day coverage set for flip-entries'' day-conditional scheduled fallback. Two config-grade columns only (location_id, entry_date); a security_invoker version would collapse to self-days for the user tier and misroute their own scheduled fallback.';

grant select on public.v_direct_feed_days to authenticated;
