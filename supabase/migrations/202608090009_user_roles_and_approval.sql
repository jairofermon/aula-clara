alter table public.profiles
  add column role text not null default 'member' check (role in ('admin', 'member')),
  add column approval_status text not null default 'approved' check (approval_status in ('pending', 'approved', 'rejected')),
  add column approved_at timestamptz,
  add column approved_by uuid references auth.users(id) on delete set null;

update public.profiles set approval_status = 'approved', approved_at = now();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and approval_status = 'approved'
  );
$$;

create or replace function public.is_approved()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and approval_status = 'approved'
  );
$$;

update public.profiles p
set role = 'admin', approval_status = 'approved', approved_at = now()
from auth.users u
where p.id = u.id and lower(u.email) = 'jairo.fermon@yahoo.com.br';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  initial_role text := case when lower(new.email) = 'jairo.fermon@yahoo.com.br' then 'admin' else 'member' end;
  initial_status text := case when lower(new.email) = 'jairo.fermon@yahoo.com.br' then 'approved' else 'pending' end;
begin
  insert into public.profiles (id, display_name, role, approval_status, approved_at)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', ''),
    initial_role,
    initial_status,
    case when initial_status = 'approved' then now() else null end
  );
  return new;
end;
$$;

drop policy if exists profiles_owner_all on public.profiles;
create policy profiles_self_select on public.profiles for select using (id = auth.uid());
create policy profiles_admin_select on public.profiles for select using (public.is_admin());
create policy profiles_admin_update on public.profiles for update
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists subjects_owner_all on public.subjects;
create policy subjects_owner_all on public.subjects for all
  using (user_id = auth.uid() and public.is_approved())
  with check (user_id = auth.uid() and public.is_approved());
drop policy if exists classes_owner_all on public.classes;
create policy classes_owner_all on public.classes for all
  using (user_id = auth.uid() and public.is_approved())
  with check (user_id = auth.uid() and public.is_approved());
drop policy if exists files_owner_all on public.class_files;
create policy files_owner_all on public.class_files for all
  using (user_id = auth.uid() and public.is_approved())
  with check (user_id = auth.uid() and public.is_approved());
drop policy if exists jobs_owner_select on public.processing_jobs;
drop policy if exists jobs_owner_insert on public.processing_jobs;
drop policy if exists jobs_owner_update on public.processing_jobs;
create policy jobs_owner_select on public.processing_jobs for select using (user_id = auth.uid() and public.is_approved());
create policy jobs_owner_insert on public.processing_jobs for insert with check (user_id = auth.uid() and public.is_approved());
create policy jobs_owner_update on public.processing_jobs for update using (user_id = auth.uid() and public.is_approved()) with check (user_id = auth.uid() and public.is_approved());
drop policy if exists chunks_owner_select on public.audio_chunks;
create policy chunks_owner_select on public.audio_chunks for select using (
  public.is_approved() and exists (select 1 from public.classes c where c.id = class_id and c.user_id = auth.uid())
);
drop policy if exists versions_owner_all on public.transcript_versions;
create policy versions_owner_all on public.transcript_versions for all using (user_id = auth.uid() and public.is_approved()) with check (user_id = auth.uid() and public.is_approved());
drop policy if exists segments_owner_all on public.transcript_segments;
create policy segments_owner_all on public.transcript_segments for all using (
  public.is_approved() and exists (select 1 from public.classes c where c.id = class_id and c.user_id = auth.uid())
) with check (
  public.is_approved() and exists (select 1 from public.classes c where c.id = class_id and c.user_id = auth.uid())
);
drop policy if exists issues_owner_all on public.transcript_issues;
create policy issues_owner_all on public.transcript_issues for all using (
  public.is_approved() and exists (select 1 from public.classes c where c.id = class_id and c.user_id = auth.uid())
) with check (
  public.is_approved() and exists (select 1 from public.classes c where c.id = class_id and c.user_id = auth.uid())
);
drop policy if exists materials_owner_all on public.materials;
create policy materials_owner_all on public.materials for all using (user_id = auth.uid() and public.is_approved()) with check (user_id = auth.uid() and public.is_approved());
drop policy if exists usage_owner_select on public.usage_records;
create policy usage_owner_select on public.usage_records for select using (
  public.is_approved() and exists (select 1 from public.classes c where c.id = class_id and c.user_id = auth.uid())
);
drop policy if exists audit_owner_select on public.audit_events;
drop policy if exists audit_owner_insert on public.audit_events;
create policy audit_owner_select on public.audit_events for select using (user_id = auth.uid() and public.is_approved());
create policy audit_owner_insert on public.audit_events for insert with check (user_id = auth.uid() and public.is_approved());

create policy subjects_admin_all on public.subjects for all
  using (public.is_admin()) with check (public.is_admin());
create policy classes_admin_all on public.classes for all
  using (public.is_admin()) with check (public.is_admin());
create policy files_admin_all on public.class_files for all
  using (public.is_admin()) with check (public.is_admin());
create policy jobs_admin_all on public.processing_jobs for all
  using (public.is_admin()) with check (public.is_admin());
create policy chunks_admin_all on public.audio_chunks for all
  using (public.is_admin()) with check (public.is_admin());
create policy versions_admin_all on public.transcript_versions for all
  using (public.is_admin()) with check (public.is_admin());
create policy segments_admin_all on public.transcript_segments for all
  using (public.is_admin()) with check (public.is_admin());
create policy issues_admin_all on public.transcript_issues for all
  using (public.is_admin()) with check (public.is_admin());
create policy materials_admin_all on public.materials for all
  using (public.is_admin()) with check (public.is_admin());
create policy usage_admin_select on public.usage_records for select using (public.is_admin());
create policy audit_admin_select on public.audit_events for select using (public.is_admin());

drop policy if exists storage_owner_select on storage.objects;
drop policy if exists storage_owner_insert on storage.objects;
drop policy if exists storage_owner_update on storage.objects;
drop policy if exists storage_owner_delete on storage.objects;
create policy storage_owner_select on storage.objects for select to authenticated using (
  public.is_approved() and bucket_id in ('class-audio', 'class-materials', 'generated-exports')
  and (storage.foldername(name))[1] = auth.uid()::text
);
create policy storage_owner_insert on storage.objects for insert to authenticated with check (
  public.is_approved() and bucket_id in ('class-audio', 'class-materials')
  and (storage.foldername(name))[1] = auth.uid()::text
);
create policy storage_owner_update on storage.objects for update to authenticated using (
  public.is_approved() and bucket_id in ('class-audio', 'class-materials')
  and (storage.foldername(name))[1] = auth.uid()::text
) with check (
  public.is_approved() and bucket_id in ('class-audio', 'class-materials')
  and (storage.foldername(name))[1] = auth.uid()::text
);
create policy storage_owner_delete on storage.objects for delete to authenticated using (
  public.is_approved() and bucket_id in ('class-audio', 'class-materials')
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy storage_admin_select on storage.objects for select to authenticated
  using (public.is_admin() and bucket_id in ('class-audio', 'class-materials', 'generated-exports'));
create policy storage_admin_insert on storage.objects for insert to authenticated
  with check (public.is_admin() and bucket_id in ('class-audio', 'class-materials', 'generated-exports'));
create policy storage_admin_update on storage.objects for update to authenticated
  using (public.is_admin() and bucket_id in ('class-audio', 'class-materials', 'generated-exports'));
create policy storage_admin_delete on storage.objects for delete to authenticated
  using (public.is_admin() and bucket_id in ('class-audio', 'class-materials', 'generated-exports'));

grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_approved() to authenticated;
