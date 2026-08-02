drop policy if exists storage_owner_delete on storage.objects;
create policy storage_owner_delete on storage.objects for delete to authenticated using (
  bucket_id in ('class-audio', 'class-materials', 'generated-exports')
  and (storage.foldername(name))[1] = auth.uid()::text
);
