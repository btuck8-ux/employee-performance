-- ============================================================================
-- 074_cp_location_crosswalk_columns.sql — the CP↔EPD location crosswalk
-- moves into public.locations (LOCATION_CODES packet, 2026-08-26).
-- ============================================================================
-- THE RULE (Tucker, adopting THQ's formulation): DO NOT KEEP A COPY OF
-- ANYTHING THE DATABASE OWNS. CP_LOCATION_MAP in
-- src/lib/ingest/culture-pulse/crosswalk.ts was a hand-maintained 8-row
-- copy of a per-store wiring fact — the same defect class that 400'd FCCSU
-- on the feeds. Precedent: mig 038 put toast_restaurant_guid ON locations;
-- the CP wiring gets the same treatment.
--
-- NULL cp columns = not CP-synced (skip, not error — the loadCrosswalk
-- precedent for a location not yet wired). FCCSU ships NULL deliberately:
-- CP carries an INACTIVE `fort_collins_csu` location, and whether CSU joins
-- the survey/schedule sync is a CP-side product decision, not a default.
-- ============================================================================

alter table public.locations
  add column if not exists cp_location_key text,
  add column if not exists cp_location_id  uuid;

comment on column public.locations.cp_location_key is
  'CulturePulse locations.location_key for this store (CP↔EPD crosswalk, '
  'mig 074 — moved from the hand-maintained CP_LOCATION_MAP). NULL = not '
  'CP-synced; the sync loaders skip, never error.';
comment on column public.locations.cp_location_id is
  'CulturePulse locations.id (uuid) for this store. Same doctrine as '
  'cp_location_key. Verified live 2026-07-26 (survey-feed handoff §4a).';

-- One CP location maps to at most one EPD store.
create unique index if not exists locations_cp_location_id_uniq
  on public.locations (cp_location_id) where cp_location_id is not null;
create unique index if not exists locations_cp_location_key_uniq
  on public.locations (cp_location_key) where cp_location_key is not null;

-- Seed: the 8 verified mappings, guarded (mig 056/057 pattern) so re-applies
-- are no-ops and a later operator change is never reverted.
update public.locations set cp_location_key = 'central_park',     cp_location_id = '5331d029-cf4a-492b-8c58-9baa3578b5e4' where location_code = 'CPD'    and cp_location_id is null;
update public.locations set cp_location_key = 'colorado_springs', cp_location_id = 'bcd5a8a6-62db-452c-9aee-a3930bf4030b' where location_code = 'COS'    and cp_location_id is null;
update public.locations set cp_location_key = 'downtown_denver',  cp_location_id = '4c9a20f7-b306-4fa6-b680-8834dbe87e9f' where location_code = 'DTD'    and cp_location_id is null;
update public.locations set cp_location_key = 'fort_collins',     cp_location_id = 'd0c95fee-1c69-463c-b08a-6720be0a78f9' where location_code = 'FCOL'   and cp_location_id is null;
update public.locations set cp_location_key = 'highlands_ranch',  cp_location_id = '93886ea2-c35f-4eec-8421-aeab07892c53' where location_code = 'HRANCH' and cp_location_id is null;
update public.locations set cp_location_key = 'longmont',         cp_location_id = '2d349e4d-b0af-4041-a35f-fcc4ee65959e' where location_code = 'LONGM'  and cp_location_id is null;
update public.locations set cp_location_key = 'houston',          cp_location_id = '653085db-7e8c-483a-aa20-615179015fe2' where location_code = 'HOU'    and cp_location_id is null;
update public.locations set cp_location_key = 'new_orleans',      cp_location_id = '8f7906ff-63b5-4a70-bd12-66e5a7456d50' where location_code = 'NOLA'   and cp_location_id is null;

-- Fail loudly if any of the 8 previously-synced stores ended up unwired —
-- a silent miss here would drop that store from the CP survey + schedule
-- syncs with no error anywhere.
do $$
declare missing text;
begin
  select string_agg(l.location_code, ', ') into missing
  from public.locations l
  where l.location_code in ('CPD','COS','DTD','FCOL','HRANCH','HOU','LONGM','NOLA')
    and (l.cp_location_id is null or l.cp_location_key is null);
  if missing is not null then
    raise exception 'cp crosswalk seed: previously-synced stores left unwired: %', missing;
  end if;
end $$;
