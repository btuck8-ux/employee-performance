-- ============================================================================
-- 016_pos_sales.sql — POS sales records and presence-based tip attribution
-- ============================================================================
-- Per-transaction sales rows from POS exports. Attribution to employees is
-- DERIVED at query time by overlapping `sales_records.transaction_at` against
-- `time_entries` where entry_type='worked'. Ike's pools tips, so the POS-
-- tagged ringer is stored for audit only and explicitly NOT used to attribute
-- tips to that one person.
--
-- Timekeeping convention: `transaction_at` is plain `timestamp` (no TZ),
-- interpreted as the store's local wall-clock time. `time_entries.in_time`
-- and `out_time` are also store-local clock-of-day values. Both sides use
-- the same clock so the overlap math is TZ-free. (Cross-location comparisons
-- still work because each store is anchored to its own clock and we never
-- mix stores in a single attribution computation.)
--
-- Tip-attribution business rules:
--   - Only transactions with abs(total_amount) < 175 enter the attribution
--     math (excludes catering / large group orders that would distort the
--     presence-based tip-rate signal). Cap is applied in the view AND in the
--     aggregation function — not at ingest, so audit and other analytics
--     keep all rows.
--   - Refunds carry signed values; sum() nets naturally.
--   - All channels (POS and THIRD_PARTY) count. Third-party rows almost
--     always have tip_amount=0, so they don't move tip totals, but they do
--     count toward sales in the tip-rate denominator.
-- ============================================================================

create table public.sales_records (
  id                uuid primary key default uuid_generate_v4(),
  location_id       uuid not null references public.locations(id) on delete cascade,
  receipt_number    text not null,
  transaction_at    timestamp not null,
  transaction_type  text not null,                    -- 'Sales' | 'Refund'
  order_type        text,                             -- Dine In | Take Out | Delivery | NOT PAID | PHONE NP
  channel           text,                             -- POS | THIRD_PARTY
  payment_type      text,
  register          text,
  pos_employee_name text,                             -- ringer name; metadata only, NOT used for tip attribution
  total_amount      numeric(10,2) not null,           -- signed: refunds negative
  tip_amount        numeric(10,2) not null default 0, -- signed: refund of tip negative
  is_refund         boolean generated always as
    (lower(transaction_type) like 'refund%' or total_amount < 0) stored,
  raw_row           jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (location_id, receipt_number)
);
create index idx_sales_loc_time on public.sales_records(location_id, transaction_at);

create trigger trg_sales_records_updated
  before update on public.sales_records
  for each row execute function public.set_updated_at();

alter table public.sales_records enable row level security;
create policy "sales_records_authenticated_all"
  on public.sales_records for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);

-- ----------------------------------------------------------------------------
-- v_sales_presence
-- One row per (sale × employee clocked-in during it). A sale rung during a
-- 3-person shift produces 3 rows. The $175 cap is NOT applied here so the
-- view stays useful for ad-hoc queries (e.g., "show me delivery sales while
-- Sarah was on shift, regardless of size"). Callers doing tip-rate or tip/hr
-- attribution must filter `abs(total_amount) < 175` themselves.
-- ----------------------------------------------------------------------------
create or replace view public.v_sales_presence as
select
  s.id              as sale_id,
  s.location_id,
  s.transaction_at,
  s.tip_amount,
  s.total_amount,
  s.channel,
  s.order_type,
  s.is_refund,
  te.employee_id
from public.sales_records s
join public.time_entries te
  on te.location_id = s.location_id
 and te.entry_type  = 'worked'
 and te.in_time  is not null
 and te.out_time is not null
 and s.transaction_at >= (te.entry_date::timestamp + te.in_time)
 and s.transaction_at <  (
       case
         when te.out_time > te.in_time
           then te.entry_date::timestamp + te.out_time
         else (te.entry_date + interval '1 day')::timestamp + te.out_time
       end
     );

-- ----------------------------------------------------------------------------
-- compute_employee_tip_metrics
-- Aggregation function called by performance-recompute.ts when rebuilding a
-- (employee, quarter) row. Returns everything the dashboard / PDF report
-- needs: employee tip rate, employee tip/hour, location averages, and the
-- tip_rate_delta_pp that drives the green-up / red-down / yellow-flat badge.
--
-- The badge math is:
--   delta_pp > +0.25    →  green up    (employee lifts the tip rate)
--   delta_pp < -0.25    →  red down    (employee drags the tip rate)
--   otherwise           →  yellow flat (within the noise band)
-- ----------------------------------------------------------------------------
create or replace function public.compute_employee_tip_metrics(
  p_employee_id uuid,
  p_location_id uuid,
  p_period_start date,
  p_period_end   date
) returns table (
  sales_under_cap            numeric,  -- sum total_amount over employee's presence, |total|<175, signed
  tips_under_cap             numeric,  -- sum tip_amount over employee's presence,   |total|<175, signed
  hours_worked               numeric,  -- employee's worked hours within window
  employee_tip_rate_pct      numeric,  -- tips / sales × 100, null if no qualifying sales
  employee_tip_per_hour      numeric,  -- tips / hours, null if no hours
  location_sales_under_cap   numeric,  -- same math at the location level
  location_tips_under_cap    numeric,
  location_hours_worked      numeric,  -- total worked hours across all employees
  location_avg_tip_rate_pct  numeric,
  location_avg_tip_per_hour  numeric,
  tip_rate_delta_pp          numeric   -- (employee_tip_rate − location_tip_rate) in percentage points
) language sql stable as $$
  with
    window_bounds as (
      select p_period_start::timestamp                       as window_start,
             (p_period_end + interval '1 day')::timestamp    as window_end
    ),
    -- Full-timestamp worked entries at this location, end-of-day clamped to
    -- next day for overnight shifts (when out_time < in_time).
    worked as (
      select te.employee_id,
             (te.entry_date::timestamp + te.in_time) as shift_start,
             case
               when te.out_time > te.in_time
                 then te.entry_date::timestamp + te.out_time
               else (te.entry_date + interval '1 day')::timestamp + te.out_time
             end as shift_end
      from public.time_entries te
      where te.location_id = p_location_id
        and te.entry_type  = 'worked'
        and te.entry_date >= p_period_start - interval '1 day'  -- include shifts that started day before
        and te.entry_date <= p_period_end
        and te.in_time  is not null
        and te.out_time is not null
    ),
    -- All sales at the location, in window, under the $175 abs cap, AND
    -- covered by at least one worked shift (this filters out sales rung in
    -- the gap between shifts, which shouldn't contribute to anyone's avg).
    location_capped_sales as (
      select s.id, s.total_amount, s.tip_amount
      from public.sales_records s
      cross join window_bounds wb
      where s.location_id = p_location_id
        and s.transaction_at >= wb.window_start
        and s.transaction_at <  wb.window_end
        and abs(s.total_amount) < 175
        and exists (
          select 1 from worked w
          where s.transaction_at >= w.shift_start
            and s.transaction_at <  w.shift_end
        )
    ),
    -- Sales that the target employee was present for. distinct on (id) so a
    -- sale isn't double-counted if an employee somehow has overlapping
    -- entries (shouldn't happen given the (employee_id,entry_date,entry_type)
    -- unique constraint, but defensive).
    employee_capped_sales as (
      select distinct on (s.id) s.id, s.total_amount, s.tip_amount
      from public.sales_records s
      cross join window_bounds wb
      join worked w
        on w.employee_id = p_employee_id
       and s.transaction_at >= w.shift_start
       and s.transaction_at <  w.shift_end
      where s.location_id = p_location_id
        and s.transaction_at >= wb.window_start
        and s.transaction_at <  wb.window_end
        and abs(s.total_amount) < 175
    ),
    employee_hours_agg as (
      select coalesce(sum(
        extract(epoch from (
          least(w.shift_end, wb.window_end) - greatest(w.shift_start, wb.window_start)
        )) / 3600.0
      ), 0) as hours
      from worked w cross join window_bounds wb
      where w.employee_id = p_employee_id
        and w.shift_end   > wb.window_start
        and w.shift_start < wb.window_end
    ),
    location_hours_agg as (
      select coalesce(sum(
        extract(epoch from (
          least(w.shift_end, wb.window_end) - greatest(w.shift_start, wb.window_start)
        )) / 3600.0
      ), 0) as hours
      from worked w cross join window_bounds wb
      where w.shift_end   > wb.window_start
        and w.shift_start < wb.window_end
    ),
    emp_totals as (
      select coalesce(sum(total_amount), 0) as sales,
             coalesce(sum(tip_amount),   0) as tips
      from employee_capped_sales
    ),
    loc_totals as (
      select coalesce(sum(total_amount), 0) as sales,
             coalesce(sum(tip_amount),   0) as tips
      from location_capped_sales
    )
  select
    et.sales                                                              as sales_under_cap,
    et.tips                                                               as tips_under_cap,
    eh.hours                                                              as hours_worked,
    case when et.sales > 0 then (et.tips / et.sales) * 100 end            as employee_tip_rate_pct,
    case when eh.hours > 0 then  et.tips / eh.hours        end            as employee_tip_per_hour,
    lt.sales                                                              as location_sales_under_cap,
    lt.tips                                                               as location_tips_under_cap,
    lh.hours                                                              as location_hours_worked,
    case when lt.sales > 0 then (lt.tips / lt.sales) * 100 end            as location_avg_tip_rate_pct,
    case when lh.hours > 0 then  lt.tips / lh.hours        end            as location_avg_tip_per_hour,
    case
      when et.sales > 0 and lt.sales > 0
        then (et.tips / et.sales - lt.tips / lt.sales) * 100
    end                                                                   as tip_rate_delta_pp
  from emp_totals et,
       loc_totals lt,
       employee_hours_agg eh,
       location_hours_agg lh;
$$;

-- ----------------------------------------------------------------------------
-- performance_records: tip metric columns. Populated by recompute when POS
-- data exists for the period at the employee's location; null otherwise so
-- the PDF report renderer can hide the section cleanly.
-- ----------------------------------------------------------------------------
alter table public.performance_records
  add column hours_worked              numeric,   -- employee's worked hours within period
  add column sales_during_presence     numeric,   -- |total|<175 sales summed over presence (signed)
  add column tips_during_presence      numeric,   -- |total|<175 tips summed over presence (signed)
  add column tip_rate_pct              numeric,   -- employee tip rate (tips/sales × 100)
  add column tip_per_hour              numeric,   -- employee tips per hour worked
  add column location_tip_rate_pct     numeric,   -- location baseline at this period
  add column location_tip_per_hour     numeric,   -- location baseline at this period
  add column tip_rate_delta_pp         numeric;   -- employee_rate − location_rate, in percentage points
