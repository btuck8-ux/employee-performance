-- ============================================================================
-- 042_hou_toast_restaurant_guid.sql — Houston's Toast restaurant GUID
-- ============================================================================
-- Captured live by the Step-0 kitchen probe's ?mode=restaurants enumeration
-- (2026-07-28): the credential's 9 restaurants include exactly one Houston
-- entry — locationName "Houston, TX", guid below. The non-EPD entries are
-- "Chico, CA" (c94eb33a-…) and a second "Fort Collins, CO" (957ebda6-…, not
-- the live FCOL store 4c60f255-…); neither ever gets a feed flag.
--
-- ⚠️ APPLY ONLY AFTER the 041-era code (sales orchestrator selecting on
-- toast_sales_enabled) is live in prod. Under pre-041 code the sales
-- orchestrator selects on "toast_restaurant_guid is not null", so setting this
-- GUID early would double-source HOU sales against the 7shifts pos_receipts
-- nightly and corrupt its tip/CS math. toast_sales_enabled stays FALSE for
-- HOU permanently; toast_kitchen_enabled is already true (041).
-- ============================================================================

update public.locations
   set toast_restaurant_guid = '4b40da81-46a3-4f91-a03b-8863661e8682'
 where location_code = 'HOU'
   and toast_restaurant_guid is null;
