-- ============================================================================
-- 073_identity_split_scan.sql — Scan B, the identity-split detector
-- (spec 2026-08-26 §8a). Ruled by Tucker, THQ's amendment accepted: the scan
-- lives at EPD, not THQ — THQ can enumerate candidate pairs from names (how
-- they reached 19) but cannot classify them. The punch/schedule asymmetry
-- that separates a split from two colleagues (27p/0s against 0p/22s) exists
-- only in EPD. Same scope rule that settled the floors and the denominators:
-- the check lives where the disambiguating evidence lives.
-- ============================================================================
-- ⚠️ Match on FIRST name as well as last — NOT optional. Nicholas Tolan /
-- Nicholas Tolson, the only real split in the estate, matches on the FIRST
-- name. The three Turners, the Beckers, the Hardings and the Griffins all
-- match on last. A detector keyed on surname alone would miss the only true
-- positive while returning every genuine pair of colleagues — the exact
-- inversion of its purpose.
--
-- SCOPE NOTE (verified against prod 2026-08-26, pre-apply dry run): the
-- agreed 19-pair baseline reconciles ONLY estate-wide (same-location pairs
-- across all stores; NOLA alone holds 5 of the 19, including the single
-- true hit at exactly the spec's 27p/0s vs 0p/22s). p_location_code NULL
-- scans every location — pairs never cross a location. The weekly cron
-- scans estate-wide so the baseline-19 drift stays readable; a one-store
-- run remains available via the parameter. Reports ONLY hits; pair_count
-- rides as metadata so a drift of one is visible.
--
-- Punch evidence: v_worked_intervals — the era-correct union of both punch
-- sources (mig 058), NEVER raw time_entries alone (§0's trap; NOLA punches
-- ride CAKE→time_entries, Colorado's ride Toast). Schedule evidence:
-- time_entries scheduled ∪ the pruned direct feed. The a.id < b.id join is
-- the self-join/double-count guard (THQ's 20→19 correction, made here
-- structurally impossible).
-- ============================================================================

create or replace function public.scan_identity_splits(
  p_location_code text default null  -- null = every location, pairs in-store
)
returns table (
  location_code   text,
  employee_code_a text,
  employee_name_a text,
  employee_code_b text,
  employee_name_b text,
  match_basis     text,
  punches_a       bigint,
  scheduled_a     bigint,
  punches_b       bigint,
  scheduled_b     bigint,
  is_hit          boolean
)
language sql stable
as $$
  with shaped as (
    select
      e.id,
      e.location_id,
      l.location_code,
      e.employee_code,
      e.employee_name,
      lower(split_part(trim(e.employee_name), ' ', 1))    as first_name,
      lower(substring(trim(e.employee_name) from '\S+$')) as last_name,
      (select count(*) from public.v_worked_intervals w
        where w.employee_id = e.id)                       as punches,
      (select count(*)
         from public.time_entries te
        where te.employee_id = e.id
          and te.entry_type = 'scheduled')
      + (select count(*)
           from public.seven_shifts_shifts s
          where s.employee_id = e.id
            and coalesce(s.deleted, false) = false
            and s.missing_upstream_since is null)         as scheduled
    from public.employees e
    join public.locations l on l.id = e.location_id
    where p_location_code is null or l.location_code = p_location_code
  )
  select
    a.location_code,
    a.employee_code, a.employee_name,
    b.employee_code, b.employee_name,
    concat_ws('+',
      case when a.last_name = b.last_name then 'last' end,
      case when a.first_name = b.first_name then 'first' end,
      case when a.last_name <> b.last_name
            and left(a.last_name, 4) = left(b.last_name, 4)
           then 'last4' end
    ) as match_basis,
    a.punches, a.scheduled,
    b.punches, b.scheduled,
    -- The asymmetry IS the split: one side holds only punches, the other
    -- only schedule. Two colleagues both accumulate both kinds of rows.
    ((a.punches > 0 and a.scheduled = 0 and b.punches = 0 and b.scheduled > 0)
     or
     (b.punches > 0 and b.scheduled = 0 and a.punches = 0 and a.scheduled > 0))
      as is_hit
  from shaped a
  join shaped b
    on a.id < b.id                      -- each pair once, never a self-join
   and a.location_id = b.location_id    -- pairs never cross a location
  where a.last_name = b.last_name
     or a.first_name = b.first_name
     or left(a.last_name, 4) = left(b.last_name, 4)
  order by 11 desc, 1, 2, 4;
$$;

comment on function public.scan_identity_splits(text) is
  'Scan B (spec 2026-08-26 §8a): same-location pairs whose name shapes '
  'collide (last name OR first name OR 4-char last-name prefix), classified '
  'by punch/schedule asymmetry — one side punch-only, the other schedule-'
  'only, is a probable identity split. NULL location = estate-wide (the '
  'agreed 19-pair baseline). Weekly cron reports hits only; pair count is '
  'drift metadata.';

revoke execute on function public.scan_identity_splits(text)
  from public, anon, authenticated;
grant execute on function public.scan_identity_splits(text) to service_role;
