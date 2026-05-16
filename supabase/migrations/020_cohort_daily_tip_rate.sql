-- ============================================================================
-- 020_cohort_daily_tip_rate.sql — Phase 7d: cohort time-series drilldown
-- ============================================================================
-- Powers the "View timeline" modal on the Team Leaderboard. For a selected
-- cohort (sorted uuid[] from team_tip_impact.member_ids), returns one row per
-- day in the window with the cohort's tip rate that day and the matching
-- location daily baseline.
--
-- Strict semantics — a sale counts toward the cohort only when EVERY person
-- on shift at that transaction time is in the cohort AND every cohort member
-- is on shift. This matches team_tip_impact's exact-set definition of a team,
-- so the drilldown numbers reconcile with the leaderboard row.
--
-- Math conventions inherited from 016:
--   * |total_amount| < $175 cap applies
--   * Refunds carry signed values; sums net
--   * Location baseline is computed over sales rung during any worked shift
--     (so it's directly comparable to the per-employee tip badge baseline).
-- ============================================================================

create or replace function public.compute_cohort_daily_tip_rate(
  p_member_ids  uuid[],
  p_location_id uuid,
  p_start_date  date,
  p_end_date    date
) returns table (
  day                    date,
  cohort_sales           numeric,
  cohort_tips            numeric,
  cohort_tip_rate_pct    numeric,
  location_sales         numeric,
  location_tips          numeric,
  location_tip_rate_pct  numeric
) language sql stable as $$
  with
    window_bounds as (
      select p_start_date::timestamp                     as window_start,
             (p_end_date + interval '1 day')::timestamp  as window_end
    ),
    member_count as (
      select array_length(p_member_ids, 1) as n
    ),
    -- All worked-during sales at the location in the window, cap-filtered.
    -- v_sales_presence already joins sales × time_entries on the (location,
    -- transaction_at ∈ shift) condition so we don't have to redo it.
    presence_rows as (
      select vsp.sale_id,
             vsp.transaction_at,
             vsp.total_amount,
             vsp.tip_amount,
             vsp.employee_id
        from public.v_sales_presence vsp, window_bounds wb
       where vsp.location_id = p_location_id
         and vsp.transaction_at >= wb.window_start
         and vsp.transaction_at <  wb.window_end
         and abs(vsp.total_amount) < 175
    ),
    -- Cohort sales: rows where the active set of employees at that sale is
    -- exactly the cohort. We require:
    --   (a) every employee present is in the cohort
    --   (b) every cohort member is present (n distinct present)
    cohort_sales_rows as (
      select pr.sale_id,
             pr.transaction_at,
             min(pr.total_amount) as total_amount,  -- min/max identical per id
             min(pr.tip_amount)   as tip_amount
        from presence_rows pr, member_count mc
       group by pr.sale_id, pr.transaction_at
      having count(*) filter (
               where not (pr.employee_id = any(p_member_ids))
             ) = 0
         and count(distinct pr.employee_id) = mc.n
    ),
    -- Location baseline: every sale (regardless of cohort), each once.
    loc_sales_rows as (
      select pr.sale_id,
             min(pr.transaction_at) as transaction_at,
             min(pr.total_amount)   as total_amount,
             min(pr.tip_amount)     as tip_amount
        from presence_rows pr
       group by pr.sale_id
    ),
    cohort_agg as (
      select transaction_at::date as d,
             sum(total_amount) as sales,
             sum(tip_amount)   as tips
        from cohort_sales_rows
       group by transaction_at::date
    ),
    loc_agg as (
      select transaction_at::date as d,
             sum(total_amount) as sales,
             sum(tip_amount)   as tips
        from loc_sales_rows
       group by transaction_at::date
    ),
    -- Full date series — emit even days with no sales / no cohort presence
    -- so the chart x-axis is gap-free.
    days as (
      select generate_series(p_start_date, p_end_date, interval '1 day')::date as d
    )
  select
    d.d                              as day,
    coalesce(ca.sales, 0)            as cohort_sales,
    coalesce(ca.tips,  0)            as cohort_tips,
    case when ca.sales > 0 then (ca.tips / ca.sales) * 100 end
                                     as cohort_tip_rate_pct,
    coalesce(la.sales, 0)            as location_sales,
    coalesce(la.tips,  0)            as location_tips,
    case when la.sales > 0 then (la.tips / la.sales) * 100 end
                                     as location_tip_rate_pct
  from days d
  left join cohort_agg ca on ca.d = d.d
  left join loc_agg    la on la.d = d.d
  order by d.d;
$$;
