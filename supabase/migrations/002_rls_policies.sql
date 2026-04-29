-- ============================================================================
-- Open-access RLS for MVP: any authenticated user has full access to all rows.
-- ============================================================================

do $$
declare t text;
begin
  for t in select unnest(array[
    'clients','locations','employees','users','user_location_access',
    'report_periods','metric_thresholds','data_uploads',
    'performance_records','generated_reports','report_generation_logs'
  ]) loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "%I_authenticated_all" on public.%I for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null)', t, t);
  end loop;
end $$;
