-- 090: revert 089. Restores FCCSU to unwired (cp_location_id/cp_location_key
-- NULL), which is prod's pre-2026-08-31 state. See 089 for the full reasoning.
update public.locations
   set cp_location_id  = null,
       cp_location_key = null,
       updated_at      = now()
 where location_code = 'FCCSU'
   and cp_location_id = '90cd4cd4-4476-40e4-abab-5af79ef98312'::uuid;
