-- 029_v_employee_scores_latest
-- "Latest scored period per employee" view for GET /api/scores?period=latest (the default).
-- Per scores-feed-endpoint-handoff.md option (a): keep the latest-per-employee logic in SQL,
--   testable, instead of reducing in the route. PostgREST can't express DISTINCT ON directly,
--   so the route points period=latest at this view and period=all|<label> at v_employee_scores.
--
-- Grain matches v_employee_scores (028): one row per (employee_code, location_code), now reduced
--   to that pair's most recent scored period (max period_start). Same columns, verbatim, so the
--   route can pass either view's rows through unchanged.
--
-- security_invoker=true (same as 028): the route queries via the service role (bypasses RLS);
--   invoker semantics keep the view from leaking rows to lower-privilege roles.
-- Additive + harmless: read-only view, no change to scoring logic or to v_employee_scores.
-- APPLIED TO PROD via Supabase MCP on 2026-06-02 (Claude Code), before merge.

create or replace view public.v_employee_scores_latest
with (security_invoker = true) as
select distinct on (employee_code, location_code)
  employee_code,
  employee_email,
  location_code,
  period_label,
  period_start,
  period_end,
  customer_service_score,
  total_impact_score,
  cs_components_count,
  tis_components_count,
  computed_at
from public.v_employee_scores
order by employee_code, location_code, period_start desc;
