create or replace function public.claim_processing_job_by_id(
  p_job_id uuid,
  p_worker_id text,
  p_lock_ttl_seconds integer default 900
)
returns setof public.processing_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select j.id
    from public.processing_jobs j
    where j.id = p_job_id
      and j.attempt_count < j.max_attempts
      and j.next_attempt_at <= now()
      and (
        j.status in ('pending', 'retry_wait')
        or (
          j.status = 'running'
          and j.locked_at < now() - make_interval(secs => p_lock_ttl_seconds)
        )
      )
    for update skip locked
  )
  update public.processing_jobs j
  set status = 'running',
      locked_by = p_worker_id,
      locked_at = now(),
      started_at = coalesce(j.started_at, now()),
      attempt_count = j.attempt_count + 1,
      error_code = null,
      error_message = null
  from candidate
  where j.id = candidate.id
  returning j.*;
end;
$$;

create or replace function public.complete_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_output jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.processing_jobs
  set status = 'completed',
      stage = 'completed',
      progress = 100,
      output_json = coalesce(p_output, '{}'::jsonb),
      finished_at = now(),
      locked_at = null,
      locked_by = null
  where id = p_job_id
    and status = 'running'
    and locked_by = p_worker_id;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.fail_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_public_message text,
  p_transient boolean,
  p_retry_delay_seconds integer default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.processing_jobs%rowtype;
  will_retry boolean;
  retry_seconds integer;
  next_status public.job_status;
begin
  select * into target
  from public.processing_jobs
  where id = p_job_id
  for update;

  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id then
    return 'ignored';
  end if;

  will_retry := p_transient and target.attempt_count < target.max_attempts;
  next_status := case
    when will_retry then 'retry_wait'::public.job_status
    else 'failed'::public.job_status
  end;
  retry_seconds := least(
    greatest(
      coalesce(
        p_retry_delay_seconds,
        least(5 * (2 ^ greatest(target.attempt_count - 1, 0)), 300)::integer
      ),
      5
    ),
    86400
  );

  update public.processing_jobs
  set status = next_status,
      stage = case when will_retry then 'backoff' else 'failed' end,
      error_code = left(p_error_code, 120),
      error_message = left(p_public_message, 500),
      next_attempt_at = case
        when will_retry then now() + make_interval(secs => retry_seconds)
        else next_attempt_at
      end,
      finished_at = case when will_retry then null else now() end,
      locked_at = null,
      locked_by = null
  where id = p_job_id;

  update public.classes
  set status = case
        when will_retry then 'queued'::public.class_status
        else 'failed'::public.class_status
      end,
      current_stage = case when will_retry then 'Nova tentativa agendada' else 'Etapa com falha' end,
      error_message = left(p_public_message, 500)
  where id = target.class_id;

  if not will_retry and target.input_json ? 'material_id' then
    update public.materials
    set status = 'failed', error_message = left(p_public_message, 500)
    where id = (target.input_json ->> 'material_id')::uuid
      and class_id = target.class_id;
  end if;

  return next_status::text;
end;
$$;

revoke all on function public.claim_processing_job_by_id(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.complete_processing_job(uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.fail_processing_job(uuid, text, text, text, boolean, integer)
  from public, anon, authenticated;

grant execute on function public.claim_processing_job_by_id(uuid, text, integer)
  to service_role;
grant execute on function public.complete_processing_job(uuid, text, jsonb)
  to service_role;
grant execute on function public.fail_processing_job(uuid, text, text, text, boolean, integer)
  to service_role;

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
  source_file_id uuid;
  chunk_id uuid;
  next_job_id uuid;
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
    source_file_id := (target.input_json ->> 'source_file_id')::uuid;
  exception when others then
    return jsonb_build_object('error_code', 'invalid_source_file');
  end;

  select * into source_file
  from public.class_files
  where id = source_file_id
    and class_id = target.class_id
    and user_id = target.user_id
    and file_type = 'audio'
    and upload_completed;

  if source_file.id is null then
    return jsonb_build_object('error_code', 'audio_missing');
  end if;
  if source_file.duration_ms is null or source_file.duration_ms <= 0 then
    return jsonb_build_object('error_code', 'duration_missing');
  end if;
  if source_file.size_bytes > p_max_bytes then
    return jsonb_build_object('error_code', 'audio_too_large');
  end if;

  select id into chunk_id
  from public.audio_chunks
  where source_file_id = source_file.id and chunk_index = 0;

  if chunk_id is null then
    insert into public.audio_chunks (
      class_id, source_file_id, chunk_index, start_ms, end_ms,
      storage_path, sha256, size_bytes, status
    ) values (
      target.class_id, source_file.id, 0, 0, source_file.duration_ms,
      source_file.storage_path, source_file.sha256, source_file.size_bytes, 'ready'
    )
    returning id into chunk_id;
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
    'transcribe_chunk:' || chunk_id::text || ':' || source_file.sha256,
    jsonb_build_object('chunk_id', chunk_id)
  )
  on conflict (idempotency_key) do update
    set idempotency_key = excluded.idempotency_key
  returning id into next_job_id;

  update public.audio_chunks
  set transcription_job_id = next_job_id,
      status = case when status = 'completed' then status else 'ready'::public.chunk_status end
  where id = chunk_id;

  update public.classes
  set status = 'transcribing',
      progress = greatest(progress, 20),
      current_stage = '0 de 1 bloco transcrito',
      error_message = null
  where id = target.class_id;

  return jsonb_build_object(
    'chunk_id', chunk_id,
    'next_job_id', next_job_id,
    'duration_ms', source_file.duration_ms,
    'resumed', was_resumed
  );
end;
$$;

create or replace function public.get_cloud_transcription_input(
  p_job_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.processing_jobs%rowtype;
  chunk public.audio_chunks%rowtype;
  context_row record;
  already_persisted boolean;
begin
  select * into target
  from public.processing_jobs
  where id = p_job_id;

  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id
     or target.job_type <> 'transcribe_chunk' then
    return jsonb_build_object('error_code', 'job_not_claimed');
  end if;

  begin
    select * into chunk
    from public.audio_chunks
    where id = (target.input_json ->> 'chunk_id')::uuid
      and class_id = target.class_id;
  exception when others then
    return jsonb_build_object('error_code', 'invalid_chunk');
  end;

  if chunk.id is null then
    return jsonb_build_object('error_code', 'chunk_missing');
  end if;

  select c.title, c.topic, c.teacher_name, c.language, c.glossary,
         s.name as subject_name
  into context_row
  from public.classes c
  join public.subjects s on s.id = c.subject_id
  where c.id = target.class_id and c.deleted_at is null;

  select exists(
    select 1 from public.transcript_segments where chunk_id = chunk.id
  ) into already_persisted;

  return jsonb_build_object(
    'chunk_id', chunk.id,
    'storage_path', chunk.storage_path,
    'size_bytes', chunk.size_bytes,
    'duration_ms', chunk.end_ms - chunk.start_ms,
    'language', context_row.language,
    'context', concat_ws(E'\n', context_row.subject_name, context_row.title,
      context_row.topic, context_row.teacher_name, context_row.glossary),
    'already_persisted', already_persisted
  );
end;
$$;

create or replace function public.persist_cloud_transcription(
  p_job_id uuid,
  p_worker_id text,
  p_segments jsonb,
  p_model_name text,
  p_duration_ms integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.processing_jobs%rowtype;
  chunk public.audio_chunks%rowtype;
  segment_item jsonb;
  ordinal bigint;
  local_start bigint;
  local_end bigint;
  segment_text text;
  next_job_id uuid;
  completed_count integer;
  total_count integer;
  inserted_count integer := 0;
begin
  select * into target
  from public.processing_jobs
  where id = p_job_id
  for update;

  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id
     or target.job_type <> 'transcribe_chunk' then
    return jsonb_build_object('error_code', 'job_not_claimed');
  end if;

  select * into chunk
  from public.audio_chunks
  where id = (target.input_json ->> 'chunk_id')::uuid
    and class_id = target.class_id
  for update;

  if chunk.id is null then
    return jsonb_build_object('error_code', 'chunk_missing');
  end if;

  if not exists(select 1 from public.transcript_segments where chunk_id = chunk.id) then
    if jsonb_typeof(p_segments) <> 'array' or jsonb_array_length(p_segments) = 0 then
      return jsonb_build_object('error_code', 'no_speech');
    end if;

    for segment_item, ordinal in
      select value, ordinality
      from jsonb_array_elements(p_segments) with ordinality
    loop
      segment_text := btrim(segment_item ->> 'text');
      local_start := (segment_item ->> 'start_ms')::bigint;
      local_end := (segment_item ->> 'end_ms')::bigint;
      if segment_text = '' or local_start < 0 or local_end <= local_start
         or local_end > (chunk.end_ms - chunk.start_ms) then
        raise exception 'invalid transcription segment';
      end if;

      insert into public.transcript_segments (
        class_id, chunk_id, transcript_version, sequence_number,
        start_ms, end_ms, speaker_label, raw_text, confidence
      ) values (
        target.class_id,
        chunk.id,
        1,
        (chunk.chunk_index * 10000 + ordinal - 1)::integer,
        chunk.start_ms + local_start,
        chunk.start_ms + local_end,
        null,
        segment_text,
        null
      )
      on conflict (class_id, transcript_version, sequence_number) do nothing;
      inserted_count := inserted_count + 1;
    end loop;
  end if;

  update public.audio_chunks set status = 'completed' where id = chunk.id;

  insert into public.usage_records (
    class_id, processing_job_id, provider, model_name, operation_type,
    audio_seconds, estimated_cost, duration_ms
  )
  select target.class_id, target.id, 'cloudflare', left(p_model_name, 200),
         'transcription', (chunk.end_ms - chunk.start_ms) / 1000.0, 0, p_duration_ms
  where not exists (
    select 1 from public.usage_records
    where processing_job_id = target.id and operation_type = 'transcription'
  );

  select count(*)::integer,
         count(*) filter (where status = 'completed')::integer
  into total_count, completed_count
  from public.audio_chunks
  where class_id = target.class_id;

  if total_count > 0 and completed_count = total_count then
    insert into public.processing_jobs (
      class_id, user_id, job_type, status, stage, idempotency_key, input_json
    ) values (
      target.class_id, target.user_id, 'assemble_transcript', 'pending', 'queued',
      'assemble_transcript:' || target.class_id::text || ':v1', '{}'::jsonb
    )
    on conflict (idempotency_key) do update
      set idempotency_key = excluded.idempotency_key
    returning id into next_job_id;
  end if;

  update public.classes
  set status = 'transcribing',
      progress = 20 + round((completed_count::numeric / greatest(total_count, 1)) * 50),
      current_stage = completed_count::text || ' de ' || total_count::text || ' blocos transcritos',
      error_message = null
  where id = target.class_id;

  return jsonb_build_object(
    'segments', inserted_count,
    'chunks_completed', completed_count,
    'chunks_total', total_count,
    'next_job_id', next_job_id,
    'resumed', inserted_count = 0
  );
end;
$$;

create or replace function public.assemble_cloud_transcript(
  p_job_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.processing_jobs%rowtype;
  segment_count integer;
  next_job_id uuid;
  was_resumed boolean;
begin
  select * into target
  from public.processing_jobs
  where id = p_job_id
  for update;

  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id
     or target.job_type <> 'assemble_transcript' then
    return jsonb_build_object('error_code', 'job_not_claimed');
  end if;

  select count(*)::integer into segment_count
  from public.transcript_segments
  where class_id = target.class_id and transcript_version = 1;
  if segment_count = 0 then
    return jsonb_build_object('error_code', 'no_speech');
  end if;

  select exists(
    select 1 from public.transcript_versions
    where class_id = target.class_id and version = 1
  ) into was_resumed;

  insert into public.transcript_versions (
    class_id, user_id, version, status, segment_count
  ) values (
    target.class_id, target.user_id, 1, 'assembled', segment_count
  )
  on conflict (class_id, version) do update
    set segment_count = excluded.segment_count;

  insert into public.processing_jobs (
    class_id, user_id, job_type, status, stage, idempotency_key, input_json
  ) values (
    target.class_id, target.user_id, 'review_transcript', 'pending', 'queued',
    'review_transcript:' || target.class_id::text || ':v1',
    jsonb_build_object('transcript_version', 1)
  )
  on conflict (idempotency_key) do update
    set idempotency_key = excluded.idempotency_key
  returning id into next_job_id;

  update public.classes
  set transcript_version = 1,
      status = 'reviewing',
      progress = 72,
      current_stage = 'Revisando transcrição',
      error_message = null
  where id = target.class_id;

  return jsonb_build_object(
    'version', 1,
    'segments', segment_count,
    'next_job_id', next_job_id,
    'resumed', was_resumed
  );
end;
$$;

revoke all on function public.prepare_cloud_audio_job(uuid, text, bigint)
  from public, anon, authenticated;
revoke all on function public.get_cloud_transcription_input(uuid, text)
  from public, anon, authenticated;
revoke all on function public.persist_cloud_transcription(uuid, text, jsonb, text, integer)
  from public, anon, authenticated;
revoke all on function public.assemble_cloud_transcript(uuid, text)
  from public, anon, authenticated;

grant execute on function public.prepare_cloud_audio_job(uuid, text, bigint)
  to service_role;
grant execute on function public.get_cloud_transcription_input(uuid, text)
  to service_role;
grant execute on function public.persist_cloud_transcription(uuid, text, jsonb, text, integer)
  to service_role;
grant execute on function public.assemble_cloud_transcript(uuid, text)
  to service_role;
