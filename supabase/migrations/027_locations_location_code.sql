-- 027_locations_location_code
-- Adds the shared location_code key for the EPD->Culture Pulse scores feed.
-- Crosswalk per epd-scores-feed-handoff.md (orchestrator-authored, 2026-06-02).
-- Additive: new column only; no change to scoring logic.
-- APPLIED TO PROD via Supabase MCP on 2026-06-02 (Cowork). Committed for parity.

alter table public.locations
  add column if not exists location_code text;

update public.locations as loc
set location_code = v.code
from (values
  ('40e22238-f031-47c8-a5a6-c1ca8f96fc5b'::uuid, 'CPD'),    -- Ike's - Central Park
  ('f347fbd9-17b6-4592-9df2-abd457770d0e'::uuid, 'COS'),    -- Ike's - Colorado Springs
  ('57eb0f78-0a35-4f64-8b8a-e9532c1dbe02'::uuid, 'DTD'),    -- Ike's - Downtown Denver
  ('aeff4706-835a-422d-9949-153ed3279b64'::uuid, 'FCOL'),   -- Ike's - Fort Collins
  ('f300a9e4-3b2c-45e3-b68c-1ee7b91f50a9'::uuid, 'HRANCH'), -- Ike's - Highlands Ranch
  ('21a129c2-7ac8-4b56-a984-1e93dbf26b41'::uuid, 'HOU'),    -- Ike's - Houston Heights (CP name differs)
  ('c6a00c2c-55b3-409f-b364-dfb156ca9a22'::uuid, 'LONGM'),  -- Ike's - Longmont
  ('570102ad-988f-4972-8475-f2f85a7dc0ae'::uuid, 'NOLA')    -- Ike's - New Orleans (CP name differs)
) as v(id, code)
where loc.id = v.id;

-- Every location must have a code (CP joins on it); enforce now that all 8 are populated.
alter table public.locations
  alter column location_code set not null;

create unique index if not exists locations_location_code_key
  on public.locations (location_code);
