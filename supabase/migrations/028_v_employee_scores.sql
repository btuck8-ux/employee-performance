-- 028_v_employee_scores
-- Backing view for the EPD->Culture Pulse scores feed (GET /api/scores).
-- Per epd-scores-feed-handoff.md (authoritative, 2026-06-02).
-- LOCKED keys: employee_code = PRIMARY join key; location_code = the code (CPD...), NOT location_key.
-- Multi-location rule (Tucker, 2026-06-02): one row per (employee, location, period) -- the natural grain
--   of this view. NOTE: EPD scopes employee_code to a single location, so a person who works two stores
--   has TWO employee_codes (each with its own location_code). Cross-location identity dedup is CP's
--   reconciliation concern (name/email bridge), not EPD's.
-- Additive: read-only view; no change to scoring logic.
-- security_invoker=true: the /api/scores route queries this view via the service role (bypasses RLS);
--   invoker semantics keep the view from leaking rows to lower-privilege roles.
-- APPLIED TO PROD via Supabase MCP on 2026-06-02 (Cowork). Committed for parity.

create or replace view public.v_employee_scores
with (security_invoker = true) as
select
  e.employee_code                              as employee_code,   -- PRIMARY join key (100%, unique, durable)
  e.email                                      as employee_email,  -- secondary / reconciliation only (33/197)
  l.location_code                              as location_code,   -- shared code (CPD...), NOT location_key
  rp.label                                     as period_label,
  rp.period_start                              as period_start,
  rp.period_end                                as period_end,
  pr.customer_service_score                    as customer_service_score,
  pr.total_impact_score                        as total_impact_score,
  pr.customer_service_score_components_count   as cs_components_count,
  pr.total_impact_score_components_count       as tis_components_count,
  pr.updated_at                                as computed_at
from public.performance_records pr
join public.employees      e  on e.id  = pr.employee_id
join public.locations      l  on l.id  = pr.location_id
join public.report_periods rp on rp.id = pr.report_period_id
where e.active;
