-- 089: fill the CP crosswalk for FCCSU. APPLIED to prod 2026-08-31, then
-- REVERTED the same session by mig 090. Parity file only — do NOT re-apply
-- on its own.
--
-- Why it was reverted: loadCpSyncLocations() filters on exactly these two
-- columns and is shared by five consumers (CP survey ingest 09:45, CP
-- schedule sync 09:40, triage/detections.ts x2, admin/probe-7shifts-shifts).
-- Setting them is not a mapping edit — it onboards the store to all of them
-- at once, and a store's FIRST schedule run backfills from
-- SCHEDULE_BACKFILL_FLOOR (2026-06-01) into time_entries(entry_type =
-- 'scheduled') and recomputes those quarters, i.e. it moves SCORED data.
-- Ruling (Tucker, 2026-08-31): onboard FCCSU as its own PR with its own
-- verification. Sizing for that PR, verified live: CP holds 102
-- weekly_schedule_entries rows for fort_collins_csu, ALL 2026-08-24 or later
-- (the store opened then), 16 people; the only frozen report_periods are
-- Q3 2025 and Q4 2025, so a 2026-06-01 floor touches nothing frozen.
update public.locations
   set cp_location_id  = '90cd4cd4-4476-40e4-abab-5af79ef98312'::uuid,
       cp_location_key = 'fort_collins_csu',
       updated_at      = now()
 where location_code = 'FCCSU'
   and cp_location_id is null;
