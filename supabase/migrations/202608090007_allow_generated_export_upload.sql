-- O proprietário pode enviar e substituir somente suas próprias exportações
-- privadas. O primeiro diretório do caminho continua sendo o auth.uid().
drop policy if exists storage_owner_insert on storage.objects;
create policy storage_owner_insert on storage.objects for insert to authenticated with check (
  bucket_id in ('class-audio', 'class-materials', 'generated-exports')
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists storage_owner_update on storage.objects;
create policy storage_owner_update on storage.objects for update to authenticated using (
  bucket_id in ('class-audio', 'class-materials', 'generated-exports')
  and (storage.foldername(name))[1] = auth.uid()::text
) with check (
  bucket_id in ('class-audio', 'class-materials', 'generated-exports')
  and (storage.foldername(name))[1] = auth.uid()::text
);
