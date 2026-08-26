-- 081: drop public.q2_gap_ledger (packet 5 §3 — queued; repo and prod move
-- together). ⛔ FILE-ONLY until its apply motion.
--
-- Preconditions verified against prod 2026-08-26 late (not assumed from
-- the packet): 0 rows, 0 dependent views (pg_depend via pg_rewrite),
-- 0 function bodies referencing it. The ledger was the Q2-blocker sprint's
-- working surface (mig 052/065); the fifth verdict closed it and nothing
-- reads it. An empty, confidently-named table is exactly the artifact a
-- cold-start session would trust — the toast_export_rows_20260826 lesson,
-- one sprint earlier.

drop table if exists public.q2_gap_ledger;
