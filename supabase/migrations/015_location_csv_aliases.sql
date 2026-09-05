-- RECOVERED 2026-09-04 from supabase_migrations.schema_migrations.statements
-- (applied to prod 2026-05-10, version 20260510042219, no file in the repo).
-- Byte-faithful to what was applied; this header is the only addition.

ALTER TABLE locations
  ADD COLUMN csv_aliases TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN locations.csv_aliases IS 'Alternate strings the CSV importer accepts as a match for this location, in addition to locations.name. Case-insensitive, trimmed comparison.';
