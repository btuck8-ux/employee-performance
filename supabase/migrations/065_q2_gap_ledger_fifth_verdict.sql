-- 065: the FIFTH verdict — no_punch_recorded_anywhere (Q2 punch-recovery
-- spec REVISED 2, §0a / §10 step 2, 2026-08-25).
--
-- Tucker's 7shifts "Hours and Wages Summary" export (2026-01-01→2026-09-03,
-- all locations, 10,097 punch rows) answered the blind bucket's central
-- question: the blind days hold nothing to fetch — 7shifts itself has no
-- record of them. "We cannot see it" and "it does not exist" are different
-- claims, and only one can be settled from inside the system (§9); the
-- export settled it from outside. Those days are TERMINAL — an operational
-- question for the floor (no-shows? scheduled before a start date? a store
-- not enforcing clock-in?), not a data hunt — and folding them into
-- still_unknown would keep a closed question open forever, while folding
-- them into confirmed_absent would claim floor-level evidence EPD does not
-- hold.
--
-- REACH (§0a-0): the verdict is only seeded where the export reconciles
-- with EPD's punch person-days exactly (HRANCH, COS, CPD; DTD to the row
-- via §0a-v) — at FCOL/LONGM/NOLA/HOU the export is short and proves
-- nothing; their blind days stay still_unknown pending a re-export. The
-- store set lives in gap-ledger.ts (EXPORT_RECONCILED_STORES).
--
-- The constraint carries its auto-generated name from the inline check in
-- mig 064 (q2_gap_ledger_verdict_check).

alter table public.q2_gap_ledger
  drop constraint q2_gap_ledger_verdict_check;

alter table public.q2_gap_ledger
  add constraint q2_gap_ledger_verdict_check check (verdict in (
    'punch_recovered',
    'confirmed_absent',
    'scheduled_after_departure',
    'still_unknown',
    'no_punch_recorded_anywhere'
  ));
