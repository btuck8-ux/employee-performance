-- ============================================================================
-- 017_pos_sales_unique_key.sql
-- ============================================================================
-- Tighten the sales_records natural key.
--
-- 016 set the upsert key to (location_id, receipt_number). That was wrong:
-- POS receipt counters reuse numbers over time (different days, sometimes
-- after a counter reset or wrap-around), so the same `receipt_number` can
-- legitimately appear on two distinct transactions. Adding `transaction_at`
-- to the key disambiguates these and future-proofs the ingest path.
--
-- This is safe to apply now while sales_records is still empty.
-- ============================================================================

alter table public.sales_records
  drop constraint sales_records_location_id_receipt_number_key;

alter table public.sales_records
  add constraint sales_records_location_id_receipt_number_transaction_at_key
  unique (location_id, receipt_number, transaction_at);
