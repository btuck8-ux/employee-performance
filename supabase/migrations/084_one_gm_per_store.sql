-- 084: one GM per store — constraint + vacancy view (GM-constraint addendum
-- §1–§2, RULED 2026-08-26; packet 5 §7.4).
--
-- ⛔ FILE-ONLY until its own apply motion (queued behind the denominator
-- branch's gated merge). Verified against prod 2026-08-26 late: 8 stores at
-- exactly 1 active manager, NOLA at 0 — the index applies cleanly and the
-- view's day-one output shows NOLA vacant, which is a TRUE POSITIVE and
-- must not be suppressed.
--
-- WHY A CONSTRAINT, NOT A FUNCTION (this sprint's lesson, twice): a rule
-- enforced by a function is only enforced where the function is called —
-- the tier gate was correct all day and a hand-written batch went around
-- it. A constraint is enforced where the write happens, and the count of
-- call sites is not knowable by inspection.
--
-- Shape decisions (all ruled, do not relitigate):
--   * Plain CREATE UNIQUE INDEX, not CONCURRENTLY — 236 rows, and
--     CONCURRENTLY cannot run inside the migration transaction.
--   * NOT DEFERRABLE — a partial index cannot back a deferrable
--     constraint, and it is not needed: a non-deferrable unique index is
--     checked at END OF STATEMENT, so demote-then-promote in one
--     transaction (or one UPDATE) works.
--   * GM fact = epd_role = 'manager' (mig 075: is_general_manager moves in
--     lockstep with the tier; the enum ordinal is the authority).

create unique index employees_one_gm_per_store
  on public.employees (location_id)
  where epd_role = 'manager' and active;

comment on index public.employees_one_gm_per_store is
  'One active GM per store (addendum §1, ruled 2026-08-26). Partial unique '
  'index — the constraint-shaped fix: enforced where the write happens, '
  'whatever writes. Demote-then-promote works in a single transaction '
  '(end-of-statement check).';

-- ── §2: v_store_gm_status — the vacancy report ─────────────────────────────
--
-- ⛔ THE TRAP this view exists to dodge: a GROUP BY over employees produces
-- ZERO rows for a store with zero managers — the vacancy report vanishes
-- exactly when it is the thing being reported. Absence is not a signal.
-- LEFT JOIN from locations: locations is the spine, one row per store,
-- always.
--
-- gm_state: vacant / ok / conflict. The conflict branch is KEPT even
-- though the index above makes it unreachable — an index can be dropped,
-- and the view must keep telling the truth if one ever is.

create or replace view public.v_store_gm_status
with (security_invoker = true) as
select
  l.id            as location_id,
  l.location_code as location_code,
  count(e.id)     as active_gm_count,
  case
    when count(e.id) = 0 then 'vacant'
    when count(e.id) = 1 then 'ok'
    else 'conflict'
  end             as gm_state,
  max(e.employee_code) as gm_employee_code,
  max(e.employee_name) as gm_employee_name
from public.locations l
left join public.employees e
  on e.location_id = l.id
 and e.epd_role = 'manager'
 and e.active
group by l.id, l.location_code;

comment on view public.v_store_gm_status is
  'One row per store, ALWAYS (LEFT JOIN from locations — a vacant store '
  'must appear, not vanish; addendum §2). gm_state vacant/ok/conflict; '
  'conflict kept although the 084 index makes it unreachable — an index '
  'can be dropped. gm_employee_code/name are the single GM when ok '
  '(max() over 0 or 1 rows; under conflict they show one of the '
  'contenders and the count says why). Day one: NOLA vacant = true '
  'positive.';
