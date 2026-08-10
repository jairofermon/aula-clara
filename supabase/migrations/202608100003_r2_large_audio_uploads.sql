-- Mantem metadados e autorizacao no PostgreSQL enquanto audios grandes ficam no
-- Cloudflare R2 privado. Uploads Supabase existentes continuam compativeis.
alter table public.class_files
  add column if not exists storage_provider text not null default 'supabase'
    check (storage_provider in ('supabase', 'r2')),
  add column if not exists multipart_upload_id text,
  add column if not exists multipart_parts jsonb not null default '[]'::jsonb
    check (jsonb_typeof(multipart_parts) = 'array');

create or replace function public.get_cloud_transcription_input(p_job_id uuid, p_worker_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  target public.processing_jobs%rowtype;
  chunk public.audio_chunks%rowtype;
  source_file public.class_files%rowtype;
  context_row record;
  target_version integer;
  already_persisted boolean;
begin
  select * into target from public.processing_jobs where id = p_job_id;
  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id
     or target.job_type <> 'transcribe_chunk' then
    return jsonb_build_object('error_code', 'job_not_claimed');
  end if;
  target_version := coalesce((target.input_json ->> 'target_transcript_version')::integer, 1);
  begin
    select * into chunk from public.audio_chunks
    where id = (target.input_json ->> 'chunk_id')::uuid and class_id = target.class_id;
  exception when others then
    return jsonb_build_object('error_code', 'invalid_chunk');
  end;
  if chunk.id is null then return jsonb_build_object('error_code', 'chunk_missing'); end if;

  select * into source_file from public.class_files where id = chunk.source_file_id;
  if source_file.id is null then return jsonb_build_object('error_code', 'audio_missing'); end if;

  select c.title, c.topic, c.teacher_name, c.language, c.glossary, s.name as subject_name
  into context_row from public.classes c join public.subjects s on s.id = c.subject_id
  where c.id = target.class_id and c.deleted_at is null;
  select exists(
    select 1 from public.transcript_segments
    where chunk_id = chunk.id and transcript_version = target_version
  ) into already_persisted;
  return jsonb_build_object(
    'chunk_id', chunk.id,
    'storage_path', chunk.storage_path,
    'storage_provider', source_file.storage_provider,
    'mime_type', source_file.mime_type,
    'original_name', source_file.original_name,
    'size_bytes', chunk.size_bytes,
    'duration_ms', chunk.end_ms - chunk.start_ms,
    'language', context_row.language,
    'context', concat_ws(E'\n', context_row.subject_name, context_row.title,
      context_row.topic, context_row.teacher_name, context_row.glossary),
    'already_persisted', already_persisted
  );
end;
$$;

grant execute on function public.get_cloud_transcription_input(uuid, text) to service_role;
