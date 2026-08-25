-- ============================================================================
-- 059_sales_records_source.sql — sales provenance discriminator
-- (Houston-to-Toast spec 2026-08-25 §3)
-- ============================================================================
-- WHY: Houston's sales sit in THREE id-spaces in one table — 7shifts
-- receipt_ids (its broken mirror, which also dropped EVERY tip since
-- 2026-05-31: $229k of sales, $0.00 of tips, while the estate runs
-- 4.8–6.9%), Toast check guids (the gap fill + the ongoing source per
-- Tucker's ruling), and the legacy-POS numeric receipts (the residual
-- delivery channel that ran to 05-04). The Houston cutover must be a
-- READ-TIME PREFERENCE, not a destructive write: never delete a source row
-- to make a number look right — supersede and prefer; retire only on
-- Tucker's explicit word. A preference needs provenance, and the table has
-- none. This column is it.
--
-- CLASSIFICATION IS BY PAYLOAD, NEVER BY KEY SHAPE (the method rule that
-- settled Houston's source: receipt-number shape cannot distinguish two
-- UUID id-spaces; raw_row can, decisively):
--   toast       ← raw_row ? 'order_guid'        (order_guid /
--                 check_display_number / revenue_center_guid …)
--   sevenshifts ← raw_row ? 'external_user_id' or 'gross_total_cents'
--                 (cents-denominated, tip_details …)
--   legacy_pos  ← raw_row ? 'payment_legs'      (the Sales & Refunds CSV
--                 import shape — pos-import.ts; numeric receipt numbers)
--   csv         ← reserved for a future generic import; NO current rows
--                 are expected to classify as csv.
-- The three shapes are mutually exclusive by construction. Rows left NULL
-- after this backfill RESIST classification and are a FINDING — report
-- them, don't guess them.
--
-- ⚠️ POST-APPLY, BEFORE ANYTHING READS THE COLUMN (spec §3): run the
-- classification report and STOP for review —
--
--   select l.location_code, coalesce(s.source, 'UNCLASSIFIED') as source,
--          count(*) as rows, min(s.transaction_at) as first,
--          max(s.transaction_at) as last
--   from sales_records s join locations l on l.id = s.location_id
--   group by 1, 2 order by 1, 2;
--
-- Expected: toast at the 6 CO stores from each go-live; sevenshifts at HOU
-- (05-31 →) and HOU pre-gap; legacy_pos at HOU (2025-08-05 →) and the CO
-- stores' Cake-era history + NOLA; zero csv; zero UNCLASSIFIED. Any
-- UNCLASSIFIED row is a finding. While reviewing, also check the two
-- legacy days that don't reconcile tip-inclusively (05-01, 05-04 — likely
-- refund handling; spec §4).
--
-- Every writer stamps the column from the deploy that follows this apply:
-- normalize.ts → 'toast' (orders feed + gap lever), receipts.ts →
-- 'sevenshifts', pos-import.ts → 'legacy_pos' (it parses exactly the
-- payment_legs Sales & Refunds format — 'csv' stays reserved for a future
-- generic importer; choice recorded in PR #32). No writer may leave it
-- null. NOT NULL is deliberately deferred until the report shows zero
-- UNCLASSIFIED and the writers are deployed — a constraint added before
-- either would break the nightly feeds.
--
-- The read-time preference itself (v_sales_effective + consumer re-emits +
-- HOU enablement) is mig 060 on the flip PR — it moves published Houston
-- numbers and must land with the flip. THIS migration is read-inert:
-- nothing reads `source` until 060 applies.
--
-- FILE-ONLY until Cowork/Tucker applies via MCP (repo↔prod parity
-- pattern). Additive + read-inert; must be applied BEFORE PR #32's writer
-- code deploys (writers stamping a column that doesn't exist would break
-- every sales feed).
-- ============================================================================

alter table public.sales_records
  add column if not exists source text
  check (source in ('sevenshifts', 'toast', 'legacy_pos', 'csv'));

comment on column public.sales_records.source is
  'Provenance discriminator (mig 059, Houston-to-Toast spec 2026-08-25): sevenshifts | toast | legacy_pos | csv. Classified from raw_row payload shape, never key format. Every writer stamps it; null on a post-059 row is a defect. Read-time source preference (mig 060) keys on it — never delete superseded rows, prefer them away.';

-- Classification backfill — idempotent (source is null guards), shapes
-- mutually exclusive. jsonb `?` requires raw_row to be non-null jsonb.
update public.sales_records
   set source = 'toast'
 where source is null
   and raw_row is not null
   and raw_row ? 'order_guid';

update public.sales_records
   set source = 'sevenshifts'
 where source is null
   and raw_row is not null
   and (raw_row ? 'external_user_id' or raw_row ? 'gross_total_cents');

update public.sales_records
   set source = 'legacy_pos'
 where source is null
   and raw_row is not null
   and raw_row ? 'payment_legs';

-- Rows still NULL here resist classification: the report query in the
-- header surfaces them per store. Do NOT add a catch-all — a guessed
-- source is worse than a loud unknown.
