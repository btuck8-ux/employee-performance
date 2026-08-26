-- ============================================================================
-- 080_nola_floor_not_null.sql — NOLA's explicit floor + metrics_start_date
-- becomes NOT NULL (floor/clamp ruling, final, 2026-08-26 evening).
-- ============================================================================
-- THE RULING (verbatim, supersedes the withdrawn straddle recommendation):
--   1. Straddling ranges CLAMP — score from the floor forward, floor date
--      INCLUSIVE (the go-live day is a sales day).
--   2. null only when a window sits WHOLLY below a store's floor.
--   3. THE FLOOR GATES COMPUTATION, NOT RETRIEVAL. A stored value is
--      served as stored, whatever its date; a period with no stored value
--      returns null, never 0. Any implementation reaching for a floor
--      comparison on the READ path has already made the mistake — Q3/Q4
--      2025 (119/103 attendance values, frozen by mig 063) sit below EVERY
--      floor and must keep being served.
--   4. NOLA gets an explicit floor of 2025-07-01.
--
-- Parity record (mig 075 idiom): Cowork applied the NOLA seed in prod
-- (snapshot nola_floor_seed_20260826) and verified it a provable no-op —
-- zero NOLA time_entries precede 2025-07-01, Q1/Q2 2026 attendance 7/13
-- unchanged, frozen 119/103 unchanged, feed total 1,005 unchanged.
--
-- ⛔ WHY NOT NULL MATTERS MORE THAN IT LOOKS: `entry_date >= floor` with a
-- NULL floor evaluates NULL — not true — and matches NOTHING. A nullable
-- clamp column is a silent whole-store outage waiting for the first query
-- that trusts it: NOLA's 20 kept attendance values would have vanished
-- with no error. Do NOT "handle" the null in queries instead — that
-- leaves the meaning inside the absence (the rule this estate has been
-- bitten by four times). This retires mig 066's "NULL = no floor"
-- semantics: every store now carries its own explicit date.
-- ============================================================================

update public.locations
   set metrics_start_date = date '2025-07-01'
 where location_code = 'NOLA' and metrics_start_date is null;

-- Fail loudly if any store is still floorless — the NOT NULL below would
-- fail anyway, but with the store named the failure is actionable.
do $$
declare missing text;
begin
  select string_agg(location_code, ', ') into missing
  from public.locations where metrics_start_date is null;
  if missing is not null then
    raise exception 'floors missing for: % — every store must carry an explicit metrics_start_date', missing;
  end if;
end $$;

alter table public.locations
  alter column metrics_start_date set not null;

comment on column public.locations.metrics_start_date is
  'THE DEMARCATION FLOOR (mig 066; NOT NULL since 080 — a nullable clamp '
  'column is a silent whole-store outage). Labor-derived metrics are '
  'computed only from entry dates >= this, floor INCLUSIVE; straddling '
  'windows CLAMP; a window wholly below returns null. GATES COMPUTATION, '
  'NOT RETRIEVAL: stored values (incl. the frozen quarters below every '
  'floor) are served as stored — never filter reads on this column. '
  'NOLA = 2025-07-01 (explicit, ruled 2026-08-26).';
