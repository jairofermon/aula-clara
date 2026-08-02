-- Qualify audio chunk columns and use prefixed PL/pgSQL variables so the
-- function remains valid when variable names overlap table column names.
create or replace function public.prepare_cloud_audio_job(
  p_job_id uuid,
  p_worker_id text,
  p_max_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.processing_jobs%rowtype;
  source_file public.class_files%rowtype;
  v_source_file_id uuid;
  v_chunk_id uuid;
  v_next_job_id uuid;
  was_resumed boolean := false;
begin
  select * into target
  from public.processing_jobs
  where id = p_job_id
  for update;

  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id
     or target.job_type <> 'prepare_audio' then
    return jsonb_build_object('error_code', 'job_not_claimed');
  end if;

  begin
    v_source_file_id := (target.input_json ->> 'source_file_id')::uuid;
  exception when others then
    return jsonb_build_object('error_code', 'invalid_source_file');
  end;

  select * into source_file
  from public.class_files as class_file
  where class_file.id = v_source_file_id
    and class_file.class_id = target.class_id
    and class_file.user_id = target.user_id
    and class_file.file_type = 'audio'
    and class_file.upload_completed;

  if source_file.id is null then
    return jsonb_build_object('error_code', 'audio_missing');
  end if;
  if source_file.duration_ms is null or source_file.duration_ms <= 0 then
    return jsonb_build_object('error_code', 'duration_missing');
  end if;
  if source_file.size_bytes > p_max_bytes then
    return jsonb_build_object('error_code', 'audio_too_large');
  end if;

  select audio_chunk.id into v_chunk_id
  from public.audio_chunks as audio_chunk
  where audio_chunk.source_file_id = source_file.id
    and audio_chunk.chunk_index = 0;

  if v_chunk_id is null then
    insert into public.audio_chunks (
      class_id, source_file_id, chunk_index, start_ms, end_ms,
      storage_path, sha256, size_bytes, status
    ) values (
      target.class_id, source_file.id, 0, 0, source_file.duration_ms,
      source_file.storage_path, source_file.sha256, source_file.size_bytes, 'ready'
    )
    returning id into v_chunk_id;
  else
    was_resumed := true;
  end if;

  insert into public.processing_jobs (
    class_id, user_id, job_type, status, stage, idempotency_key, input_json
  ) values (
    target.class_id,
    target.user_id,
    'transcribe_chunk',
    'pending',
    'queued',
    'transcribe_chunk:' || v_chunk_id::text || ':' || source_file.sha256,
    jsonb_build_object('chunk_id', v_chunk_id)
  )
  on conflict (idempotency_key) do update
    set idempotency_key = excluded.idempotency_key
  returning id into v_next_job_id;

  update public.audio_chunks as audio_chunk
  set transcription_job_id = v_next_job_id,
      status = case
        when audio_chunk.status = 'completed' then audio_chunk.status
        else 'ready'::public.chunk_status
      end
  where audio_chunk.id = v_chunk_id;

  update public.classes as class_record
  set status = 'transcribing',
      progress = greatest(class_record.progress, 20),
      current_stage = '0 de 1 bloco transcrito',
      error_message = null
  where class_record.id = target.class_id;

  return jsonb_build_object(
    'chunk_id', v_chunk_id,
    'next_job_id', v_next_job_id,
    'duration_ms', source_file.duration_ms,
    'resumed', was_resumed
  );
end;
$$;

revoke all on function public.prepare_cloud_audio_job(uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.prepare_cloud_audio_job(uuid, text, bigint)
  to service_role;
