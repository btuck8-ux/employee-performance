-- ============================================================================
-- Phase 8 — direct browser → Supabase Storage upload bucket for importer CSVs.
--
-- The Vercel lambda body cap (4.5 MB at the edge) bit us on DT's 4.6 MB POS
-- export, which forced a manual split. The fix is to upload the file straight
-- from the browser to Storage, then hand the server action the storage path
-- instead of the file bytes — sidesteps the cap entirely.
--
-- Flow per importer (POS, employees, time, tattle, reviews, surveys, tasks):
--   1. Client uploads the file to csv-uploads/.
--   2. Submits the form with a hidden storage_path field.
--   3. Server action downloads the object, parses, ingests, then DELETEs it.
--
-- Orphans (uploaded but never ingested — e.g., user closed the tab mid-upload)
-- are rare since the action's `finally` block always cleans up on its own
-- path. A periodic sweep would be belt-and-suspenders; not adding one yet.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('csv-uploads', 'csv-uploads', false)
on conflict (id) do nothing;

create policy "csv_uploads_authenticated_select"
  on storage.objects for select to authenticated
  using (bucket_id = 'csv-uploads');

create policy "csv_uploads_authenticated_insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'csv-uploads');

create policy "csv_uploads_authenticated_delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'csv-uploads');
