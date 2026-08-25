-- 064: q2_gap_ledger — the verdict ledger (Q2 punch-recovery spec REVISED 2,
-- 2026-08-25 §5b).
--
-- Tucker's objective is not "run a backfill" — it is "find the punches
-- and/or determine if they are genuinely absent on those days." That
-- finishes as a ledger: one row per Q2 2026 gap day (a scheduled day with
-- no punch from either punch source), each carrying exactly one verdict.
-- The ledger is a SNAPSHOT-plus-verdicts table rather than a live view
-- because a recovered punch makes the day stop LOOKING like a gap — the
-- ledger must remember that it was one, and that it was recovered.
--
-- Verdicts (§5b, exactly four):
--   punch_recovered           a punch was retrieved and written for that
--                             employee on that date
--   confirmed_absent          POSITIVE evidence the person did not work.
--                             The absence of a punch is NOT that evidence —
--                             it is the thing being investigated (§9).
--   scheduled_after_departure the day falls after the employee's last punch
--                             ever — a denominator error, NOT a synonym for
--                             absent; how the metric eventually treats it is
--                             a separate Tucker decision (§5b).
--   still_unknown             everything else. Counted and named, never
--                             quietly folded into "absent".
--
-- `signal` carries sub-verdict evidence markers (e.g. the §3e late/none
-- conviction: 7shifts asserts attended + EPD holds no punch = confirmed
-- MISSING PUNCH, which is still still_unknown until the punch is actually
-- recovered).
--
-- Seeding + verdict transitions ride /api/admin/q2-gap-ledger (dry-run
-- default). Re-seeding NEVER overwrites an existing row — human
-- confirmations and recovery marks are append-only facts.
--
-- Q2 2026 is recomputed once, when this table's still_unknown count is a
-- number Tucker has seen and accepted (§7). Nothing publishes before that.

create table if not exists public.q2_gap_ledger (
  id            uuid primary key default uuid_generate_v4(),
  employee_id   uuid not null references public.employees(id) on delete cascade,
  location_id   uuid not null references public.locations(id) on delete cascade,
  gap_date      date not null,
  verdict       text not null check (verdict in (
                  'punch_recovered',
                  'confirmed_absent',
                  'scheduled_after_departure',
                  'still_unknown'
                )),
  evidence      text not null,
  signal        text,
  seeded_at     timestamptz not null default now(),
  decided_at    timestamptz,
  unique (employee_id, gap_date)
);

create index if not exists idx_q2_gap_ledger_verdict
  on public.q2_gap_ledger (verdict);
create index if not exists idx_q2_gap_ledger_location
  on public.q2_gap_ledger (location_id, gap_date);

-- RLS: operator tool — system_admin only, the 052 pattern. Operational
-- writes ride the service role (bypasses RLS) per the 047 doctrine.
alter table public.q2_gap_ledger enable row level security;

create policy q2_gap_ledger_sa_all on public.q2_gap_ledger
  for all to authenticated
  using ((select public.epd_is_system_admin()))
  with check ((select public.epd_is_system_admin()));
