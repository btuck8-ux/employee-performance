-- ============================================================================
-- Seed quarterly report_periods for 2024-2027.
-- ============================================================================
do $$
declare y int; q int;
begin
  for y in 2024..2027 loop
    for q in 1..4 loop
      perform public.upsert_quarter(y, q);
    end loop;
  end loop;
end $$;

-- ============================================================================
-- Storage buckets (private)
-- ============================================================================
insert into storage.buckets (id, name, public)
values
  ('reports', 'reports', false),
  ('uploads', 'uploads', false)
on conflict (id) do nothing;

create policy "reports_authenticated_select" on storage.objects for select to authenticated using (bucket_id = 'reports');
create policy "reports_authenticated_insert" on storage.objects for insert to authenticated with check (bucket_id = 'reports');
create policy "reports_authenticated_update" on storage.objects for update to authenticated using (bucket_id = 'reports') with check (bucket_id = 'reports');
create policy "reports_authenticated_delete" on storage.objects for delete to authenticated using (bucket_id = 'reports');

create policy "uploads_authenticated_select" on storage.objects for select to authenticated using (bucket_id = 'uploads');
create policy "uploads_authenticated_insert" on storage.objects for insert to authenticated with check (bucket_id = 'uploads');
create policy "uploads_authenticated_update" on storage.objects for update to authenticated using (bucket_id = 'uploads') with check (bucket_id = 'uploads');
create policy "uploads_authenticated_delete" on storage.objects for delete to authenticated using (bucket_id = 'uploads');
