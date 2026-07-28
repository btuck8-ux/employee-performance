-- ============================================================================
-- 041_toast_kitchen_feed.sql — Toast Kitchen ticket-time feed (Kitchen Speed)
-- ============================================================================
-- Handoff 2026-07-28 (handoff-toast-kitchen-time-2026-07-28.md §5.1/§6.2).
-- Step-0 probe PASSED 2026-07-28: /kitchen/v1/export/itemFulfillments returns
-- 200 + data on this credential (no RMS Pro+ 204 gate) for COS and HOU across
-- weekday + weekend businessDates. Probe facts baked in below:
--   - grain: one row per (ticket, selection, prep station, fulfillment level);
--     level-1 (expediter) rows carry a NULL prep station -> default ''.
--     Toast can emit byte-identical duplicate rows (HOU 20260727: 3 of 452);
--     the ingest dedupes in-batch, so the unique index below holds.
--   - ticketFiredAt / itemFulfilledAt: 0 nulls observed -> prep_seconds
--     computable everywhere; observed p50 ~360-595s, max 2105s (7200s outlier
--     cap in the functions has ample headroom).
--   - volume ~300-600 rows/store/day -> no pagination concern (the export
--     takes only businessDate).
--
-- ORDERING NOTE (sales double-source guard): this migration is additive and
-- safe under the PRE-041 code (old orchestrator still selects on
-- toast_restaurant_guid). 042 (HOU's restaurant GUID) must NOT be applied
-- until the code that selects on toast_sales_enabled is live in prod,
-- otherwise the old sales orchestrator would pick HOU up and double-source
-- its sales against the 7shifts pos_receipts nightly.
--
-- Apply to prod via Supabase MCP; this file is the parity copy.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Explicit feed flags (handoff §2.3 — replaces the implicit
--    "toast_restaurant_guid is not null" sales guard so the GUID column can
--    become pure identity and HOU can join the kitchen feed sales-free).
-- ----------------------------------------------------------------------------
alter table public.locations add column if not exists toast_sales_enabled   boolean not null default false;
alter table public.locations add column if not exists toast_kitchen_enabled boolean not null default false;

update public.locations set toast_sales_enabled = true
  where location_code in ('COS','CPD','DTD','FCOL','HRANCH','LONGM');
update public.locations set toast_kitchen_enabled = true
  where location_code in ('COS','CPD','DTD','FCOL','HRANCH','LONGM','HOU');
-- HOU's toast_restaurant_guid is set in 042 (post-deploy; see ordering note).

-- ----------------------------------------------------------------------------
-- 2. ingest_runs source
-- ----------------------------------------------------------------------------
alter table public.ingest_runs drop constraint if exists ingest_runs_source_check;
alter table public.ingest_runs add constraint ingest_runs_source_check check (source = any (array[
  '7shifts_time','7tasks','pos_receipts','cake_timesheets',
  'tattle','reviews','toast_sales','culture_pulse','toast_kitchen']));

-- ----------------------------------------------------------------------------
-- 3. The fulfillment table
-- ----------------------------------------------------------------------------
create table if not exists public.toast_item_fulfillments (
  id                      uuid primary key default gen_random_uuid(),
  location_id             uuid not null references public.locations(id) on delete cascade,
  business_date           date not null,
  order_guid              text not null,
  ticket_guid             text not null,
  selection_guid          text not null,
  -- level-1 (expediter) rows have no prep station; '' keeps the unique index total.
  prep_station_guid       text not null default '',
  prep_station_name       text,
  item_fulfillment_level  smallint not null default 0,
  menu_item_guid          text,
  menu_item_name          text,
  dining_option_behavior  text,
  course_name             text,
  order_source            text,
  ticket_fired_at         timestamptz,
  item_started_at         timestamptz,
  item_fulfilled_at       timestamptz,
  -- store-local projection of ticket_fired_at, written at ingest (§5.3) so the
  -- attribution join against time_entries' TZ-free local clock is plain SQL.
  fired_local_date        date,
  fired_local_time        time,
  prep_seconds            integer,
  raw                     jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Grain confirmed by the Step-0 probe (§4.3 q2); exact-duplicate export rows
-- are deduped in-batch by the ingest before upserting on this key.
create unique index if not exists toast_item_fulfillments_key
  on public.toast_item_fulfillments
     (location_id, ticket_guid, selection_guid, prep_station_guid, item_fulfillment_level);

create index if not exists toast_item_fulfillments_attr_idx
  on public.toast_item_fulfillments (location_id, fired_local_date, fired_local_time);

alter table public.toast_item_fulfillments enable row level security;
drop policy if exists toast_item_fulfillments_authenticated_read on public.toast_item_fulfillments;
create policy toast_item_fulfillments_authenticated_read
  on public.toast_item_fulfillments
  for select
  to authenticated
  using (auth.uid() is not null);

-- ----------------------------------------------------------------------------
-- 4. Which roles count as kitchen — seeded EMPTY on purpose (§3.4).
--    The live post-backfill vocabulary is: CO stores CREW MEMBER / SHIFT LEAD /
--    TEAM LEAD / GENERAL MANAGER / TRAINING; HOU Finish / MOD / Dishwasher /
--    Host. Which of those count as "kitchen" is Tucker's call — an empty table
--    means zero attribution, which is the safe failure. Seed in a follow-up
--    migration once decided. Do not guess.
-- ----------------------------------------------------------------------------
create table if not exists public.kitchen_role_config (
  id          uuid primary key default gen_random_uuid(),
  role_name   text not null unique,
  is_kitchen  boolean not null default true,
  notes       text,
  created_at  timestamptz not null default now()
);
alter table public.kitchen_role_config enable row level security;
drop policy if exists kitchen_role_config_authenticated_read on public.kitchen_role_config;
create policy kitchen_role_config_authenticated_read
  on public.kitchen_role_config
  for select
  to authenticated
  using (auth.uid() is not null);

-- ----------------------------------------------------------------------------
-- 5. Per-employee kitchen metrics (mirrors the tip pattern: own value +
--    location value + delta, all on performance_records).
-- ----------------------------------------------------------------------------
alter table public.performance_records
  add column if not exists kitchen_tickets                    integer,
  add column if not exists kitchen_avg_prep_seconds           numeric,
  add column if not exists location_kitchen_avg_prep_seconds  numeric,
  add column if not exists kitchen_prep_delta_seconds         numeric;

-- ----------------------------------------------------------------------------
-- 6. Aggregates (handoff §6.2) — computed on demand at recompute time; no
--    per-ticket attribution table (~10k rows/day would buy nothing but bloat).
--
-- Attribution rule (§6.1): a fulfillment row counts toward an employee iff the
-- employee was ON SHIFT at ticket_fired_at (store-local) at that location AND
-- their time_entries.role is an is_kitchen role. Deliberately NO
-- worked_that_day fallback — at ~hundreds of tickets/day a day-level smear
-- would attribute the whole kitchen to every cashier. Unattributed rows still
-- count toward the location aggregate.
--
-- Hygiene (§6.3): prep_seconds <= 0 (clock skew / re-fires) and > 7200
-- (tickets left un-bumped) are excluded from both aggregates. Median returned
-- alongside the mean — kitchen times are right-skewed (probe: p50 360-595s vs
-- p90 774-1187s); the stored headline is the mean until Tucker picks.
-- ----------------------------------------------------------------------------
create or replace function public.compute_kitchen_speed(
  p_employee_id uuid,
  p_location_id uuid,
  p_start       date,
  p_end         date
) returns table (
  tickets          integer,
  items            integer,
  avg_prep_seconds numeric,
  med_prep_seconds numeric
)
language sql stable as $$
  select
    count(distinct f.ticket_guid)::integer                       as tickets,
    count(*)::integer                                            as items,
    round(avg(f.prep_seconds), 1)                                as avg_prep_seconds,
    percentile_cont(0.5) within group (order by f.prep_seconds)  as med_prep_seconds
  from public.toast_item_fulfillments f
  where f.location_id = p_location_id
    and f.fired_local_date between p_start and p_end
    and f.prep_seconds is not null
    and f.prep_seconds > 0
    and f.prep_seconds <= 7200
    and exists (
      select 1
      from public.time_entries te
      where te.employee_id = p_employee_id
        and te.location_id = f.location_id
        and te.entry_date  = f.fired_local_date
        and te.entry_type  = 'worked'
        and te.in_time  is not null
        and te.out_time is not null
        and te.in_time  <= f.fired_local_time
        and f.fired_local_time <= te.out_time
        and te.role in (select role_name from public.kitchen_role_config where is_kitchen)
    );
$$;

create or replace function public.compute_location_kitchen_speed(
  p_location_id uuid,
  p_start       date,
  p_end         date
) returns table (
  tickets          integer,
  items            integer,
  avg_prep_seconds numeric,
  med_prep_seconds numeric
)
language sql stable as $$
  select
    count(distinct f.ticket_guid)::integer                       as tickets,
    count(*)::integer                                            as items,
    round(avg(f.prep_seconds), 1)                                as avg_prep_seconds,
    percentile_cont(0.5) within group (order by f.prep_seconds)  as med_prep_seconds
  from public.toast_item_fulfillments f
  where f.location_id = p_location_id
    and f.fired_local_date between p_start and p_end
    and f.prep_seconds is not null
    and f.prep_seconds > 0
    and f.prep_seconds <= 7200;
$$;
