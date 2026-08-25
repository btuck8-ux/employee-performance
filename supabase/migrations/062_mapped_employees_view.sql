-- ============================================================================
-- 062_mapped_employees_view.sql — "can EPD see this employee's punches?"
-- (unmapped-null spec 2026-08-25, Build 2)
-- ============================================================================
-- THE DEFECT THIS SERVES: five employees with zero crosswalk rows scored
-- 0% under the flip — their scheduled days counted while their punches sat
-- invisible in the unmatched queue (three of them demonstrably worked).
-- "Absence of a punch IS absence" is correct only for a MAPPED employee;
-- for an unmapped one, absence of a punch means the system has no way to
-- look. The sprint's sixth same-class occurrence, and the first the flip
-- itself introduced. The rule now pinned: a metric that can be blind must
-- be able to say so — a zero that means "cannot see" is indistinguishable
-- downstream from a zero that means "was not there".
--
-- flip-entries.ts nulls attendance/punctuality for an unmapped employee's
-- post-go-live days (same treatment as the evidenced non-puncher,
-- different reason). To know who is mapped it needs crosswalk PRESENCE —
-- but toast_employee_crosswalk is SA-only (mig 055, correctly: it carries
-- Toast GUIDs and match evidence), so a session-client caller would see
-- every employee as unmapped and null the estate. This view is the
-- v_location_flip_config / v_direct_feed_days pattern a third time:
-- DEFINER-rights (expect the advisor flag — deliberate), exposing exactly
-- (location_id, employee_id) — mapping PRESENCE, no GUIDs, no evidence.
--
-- ⚠️ Scope note (spec Build 2): a crosswalk row with ZERO punches is NOT
-- the unmapped case — the mapping exists, EPD can see, and seeing nothing
-- is real absence (Sierra Estrada at COS: row present, no punches, 0% is
-- CORRECT; she belongs on the anomaly list, not in this fix).
--
-- FILE-ONLY until Cowork/Tucker applies via MCP. Additive; must be applied
-- BEFORE the Build 2 code deploys (flip-entries reads it) and before any
-- Build 1 write pass (sequencing: the five must recompute to null, never
-- to zero first).
-- ============================================================================

create or replace view public.v_mapped_employees as
select distinct location_id, employee_id
from public.toast_employee_crosswalk;

comment on view public.v_mapped_employees is
  'DELIBERATELY definer-rights: crosswalk mapping PRESENCE only (location_id, employee_id — no GUIDs, no evidence) so flip-entries can distinguish "mapped but absent" (real 0%) from "unmapped, cannot see" (null) under every session tier. Base-table protection stays SA-only on toast_employee_crosswalk.';

grant select on public.v_mapped_employees to authenticated;
