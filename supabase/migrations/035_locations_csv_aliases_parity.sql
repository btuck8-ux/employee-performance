-- ============================================================================
-- 035_locations_csv_aliases_parity.sql — capture csv_aliases in a migration
-- ============================================================================
-- locations.csv_aliases drives the strict-equality location match used by the
-- CSV importers (tattle-import.ts, customer-review-import.ts, survey, etc. via
-- rowMatchesLocation()): an import row whose vendor location label equals the
-- canonical name OR any alias is routed to that location.
--
-- Parity gap this fixes: the column AND every alias value were applied directly
-- against prod (uyjlnciqecfcxsooupaa) via MCP and were never captured in a
-- migration. A fresh reseed from migrations would therefore come up with NO
-- csv_aliases column at all, regressing label matching for every location — not
-- just the Houston additions made during the 2026-06-09 data-currency pass
-- ("Houston" and "Ike's Love and Sandwiches", needed so Tattle/Snapshot and the
-- 7shifts Tasks export labels match HOU).
--
-- This migration snapshots the current prod state so repo == prod:
--   1. create the column if it is missing (text[]).
--   2. seed all 8 locations' aliases, keyed by the stable location_code.
--
-- Idempotent and additive: re-applying on prod sets the same values it already
-- holds. Values verified against prod on 2026-06-09.
-- ============================================================================

alter table public.locations
  add column if not exists csv_aliases text[];

update public.locations as loc
set csv_aliases = v.aliases
from (
  values
    ('COS',    array['Colorado Springs']),
    ('CPD',    array['Central Park', 'Denver (Central Park)']),
    ('DTD',    array['Downtown Denver', 'Denver (Downtown)']),
    ('FCOL',   array['Fort Collins']),
    ('HOU',    array['Houston Heights', 'Houston', 'Ike''s Love and Sandwiches']),
    ('HRANCH', array['Highlands Ranch', 'Denver (Highlands Ranch)']),
    ('LONGM',  array['Longmont']),
    ('NOLA',   array['New Orleans', '1940 Dauphine St, New Orleans, LA 70116, USA'])
) as v(location_code, aliases)
where loc.location_code = v.location_code;
