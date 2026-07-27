-- ============================================================================
-- 038_toast_sales_feed.sql — direct EPD<->Toast sales feed for the 6 CO stores
-- ============================================================================
-- The 6 Colorado stores migrated POS Cake -> Toast at the start of July 2026.
-- Their historical hole (5/13 -> go-live) was closed by the one-time Cake
-- backfill (2026-07-26); this migration wires the PERMANENT feed: a nightly
-- server-side pull from Toast's Orders API (handoff-co-sales-toast-plus-cake-
-- 2026-07-26.md §2) writing the same sales_records rows the POS importer
-- produces. pos_via_7shifts stays FALSE for CO — this feed is NOT via 7shifts.
--
-- 1) ingest_runs.source gains 'toast_sales' (the feed's run-log key).
-- 2) locations.toast_restaurant_guid — the Toast restaurantGuid sent as
--    Toast-Restaurant-External-ID on every Orders API call. Mirrors how the
--    seven_shifts_* ids live on locations rather than in a hardcoded TS map.
--    ONLY the 6 CO stores get a GUID: the provisioned credential can see 9
--    locations (CO + Houston + Chico/Kona), but Houston's sales already flow
--    through the 7shifts pos_receipts nightly (a Toast pull would double-
--    source it) and Chico/Kona are not EPD stores. The orchestrator selects
--    `where toast_restaurant_guid is not null` — never "all the credential
--    can see" — so leaving HOU's NULL is the enforcement. Do not populate it.
-- 3) locations.toast_sales_start_date — that store's Toast go-live (the day
--    after its Cake backfill ends). The feed clamps every pull window to this
--    floor so Toast can never write into Cake's territory (pre-go-live Toast
--    days hold only test-mode orders; the seam stays gap- and overlap-free).
--
-- NOTE: locations.actuals_source intentionally stays '7shifts' for CO — that
-- column gates the nightly 7shifts LABOR pull (orchestrator), and CO labor
-- still comes from 7shifts company 185592. Only sales move to Toast.
--
-- Idempotent (drop-if-exists + re-add / add column if not exists). Apply to
-- prod via Supabase MCP for repo<->prod parity (the 030-037 pattern).
-- ============================================================================

alter table public.ingest_runs
  drop constraint if exists ingest_runs_source_check;

alter table public.ingest_runs
  add constraint ingest_runs_source_check
  check (source in (
    '7shifts_time',
    '7tasks',
    'pos_receipts',
    'cake_timesheets',
    'tattle',
    'reviews',
    'toast_sales'
  ));

alter table public.locations
  add column if not exists toast_restaurant_guid text,
  add column if not exists toast_sales_start_date date;

update public.locations set toast_restaurant_guid = '4e7b6b0e-e5f4-486f-b558-57beabd07bbf', toast_sales_start_date = '2026-07-07' where location_code = 'COS';
update public.locations set toast_restaurant_guid = '61ad3f5c-f761-4dd6-8129-0591192aca94', toast_sales_start_date = '2026-07-01' where location_code = 'CPD';
update public.locations set toast_restaurant_guid = '67ec50d2-a93b-4dc0-8e1e-bda060d5fd4e', toast_sales_start_date = '2026-07-02' where location_code = 'DTD';
update public.locations set toast_restaurant_guid = '4c60f255-8e97-4dbf-ab13-7d57d9b03c6b', toast_sales_start_date = '2026-07-08' where location_code = 'FCOL';
update public.locations set toast_restaurant_guid = '20f3e2b5-b09b-4c0a-ac6f-ab23bef59a2d', toast_sales_start_date = '2026-07-03' where location_code = 'HRANCH';
update public.locations set toast_restaurant_guid = '6f95eaa1-b117-47da-a2ea-8a0b1fd0a580', toast_sales_start_date = '2026-07-09' where location_code = 'LONGM';
