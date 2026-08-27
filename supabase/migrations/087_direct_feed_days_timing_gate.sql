-- 087: withdrawal-timing gate on the store-day coverage set (packet 10 §3;
-- Tucker rulings 2026-08-27 — packet 9 §4b Call 1 + Call 2).
--
-- A vendor-withdrawn shift STOOD iff it was withdrawn STRICTLY AFTER its
-- shift date on the STORE-LOCAL calendar; withdrawn on/before = cancelled.
-- A stood shift is a real schedule, so its day belongs in the direct feed's
-- covered-day set exactly like a live shift's day. The TS twin is
-- flip-entries' withdrawnRowStood, applied in the day set, the per-employee
-- coverage starts, and the removal evidence — this view is the only SQL
-- site carrying the pruned filter.
--
-- The local-date compare needs the store zone, so the view now joins
-- locations. Same definer-rights posture as mig 061 (advisor flag expected,
-- deliberate): the whole point is the STORE-level day set under a Class-1
-- session client. deleted/draft rows carry no withdrawal timestamp and stay
-- excluded — the gate only judges what it can date.

create or replace view public.v_direct_feed_days as
select distinct s.location_id, s.entry_date
from public.seven_shifts_shifts s
join public.locations l on l.id = s.location_id
where s.deleted = false
  and s.draft = false
  and (
    s.missing_upstream_since is null
    or (s.missing_upstream_since at time zone l.timezone)::date > s.entry_date
  );

comment on view public.v_direct_feed_days is
  'DELIBERATELY definer-rights: the pruned direct feed''s store-day coverage set for flip-entries'' day-conditional scheduled fallback. Two config-grade columns only (location_id, entry_date). Since 087 the prune carries the withdrawal-timing gate: tombstoned rows count when withdrawn strictly after their store-local shift date (they STOOD); the TS twin is flip-entries.withdrawnRowStood.';

grant select on public.v_direct_feed_days to authenticated;
