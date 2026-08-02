alter table public.profiles enable row level security;
alter table public.subjects enable row level security;
alter table public.classes enable row level security;
alter table public.class_files enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.audio_chunks enable row level security;
alter table public.transcript_versions enable row level security;
alter table public.transcript_segments enable row level security;
alter table public.transcript_issues enable row level security;
alter table public.materials enable row level security;
alter table public.usage_records enable row level security;
alter table public.audit_events enable row level security;

create policy profiles_owner_all on public.profiles for all using (id = auth.uid()) with check (id = auth.uid());
create policy subjects_owner_all on public.subjects for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy classes_owner_all on public.classes for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy files_owner_all on public.class_files for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy jobs_owner_select on public.processing_jobs for select using (user_id = auth.uid());
create policy jobs_owner_insert on public.processing_jobs for insert with check (user_id = auth.uid());
create policy jobs_owner_update on public.processing_jobs for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy chunks_owner_select on public.audio_chunks for select using (
  exists (select 1 from public.classes c where c.id = class_id and c.user_id = auth.uid())
);
create policy versions_owner_all on public.transcript_versions for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy segments_owner_all on public.transcript_segments for all using (
  exists (select 1 from public.classes c where c.id = class_id and c.user_id = auth.uid())
) with check (
  exists (select 1 from public.classes c where c.id = class_id and c.user_id = auth.uid())
);
create policy issues_owner_all on public.transcript_issues for all using (
  exists (select 1 from public.classes c where c.id = class_id and c.user_id = auth.uid())
) with check (
  exists (select 1 from public.classes c where c.id = class_id and c.user_id = auth.uid())
);
create policy materials_owner_all on public.materials for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy usage_owner_select on public.usage_records for select using (
  exists (select 1 from public.classes c where c.id = class_id and c.user_id = auth.uid())
);
create policy audit_owner_select on public.audit_events for select using (user_id = auth.uid());
create policy audit_owner_insert on public.audit_events for insert with check (user_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('class-audio', 'class-audio', false, 524288000, array['audio/m4a','audio/mp4','audio/mpeg','audio/wav','audio/x-m4a','audio/x-wav','audio/webm','video/mp4','video/webm']),
  ('class-materials', 'class-materials', false, 52428800, array['application/pdf','text/plain']),
  ('generated-exports', 'generated-exports', false, 52428800, array['application/pdf','text/csv'])
on conflict (id) do update set public = excluded.public;

create policy storage_owner_select on storage.objects for select to authenticated using (
  bucket_id in ('class-audio', 'class-materials', 'generated-exports')
  and (storage.foldername(name))[1] = auth.uid()::text
);
create policy storage_owner_insert on storage.objects for insert to authenticated with check (
  bucket_id in ('class-audio', 'class-materials')
  and (storage.foldername(name))[1] = auth.uid()::text
);
create policy storage_owner_update on storage.objects for update to authenticated using (
  bucket_id in ('class-audio', 'class-materials')
  and (storage.foldername(name))[1] = auth.uid()::text
) with check (
  bucket_id in ('class-audio', 'class-materials')
  and (storage.foldername(name))[1] = auth.uid()::text
);
create policy storage_owner_delete on storage.objects for delete to authenticated using (
  bucket_id in ('class-audio', 'class-materials')
  and (storage.foldername(name))[1] = auth.uid()::text
);
