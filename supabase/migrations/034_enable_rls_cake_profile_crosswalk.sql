-- 034_enable_rls_cake_profile_crosswalk
-- Harden cake_profile_crosswalk to match the ingest_runs security posture:
-- RLS enabled, authenticated read-only. Writes happen only via the
-- service-role ingest client, which bypasses RLS. Migration 031 created the
-- table without RLS; this closes that gap.
-- Applied to prod 2026-06-08 via Supabase MCP (Cowork); committed here for parity.

ALTER TABLE cake_profile_crosswalk ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cake_profile_crosswalk_authenticated_read ON cake_profile_crosswalk;
CREATE POLICY cake_profile_crosswalk_authenticated_read
  ON cake_profile_crosswalk
  FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);
