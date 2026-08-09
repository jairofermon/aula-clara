-- Suporta uma nova transcrição preservando versões anteriores e sem compactar
-- centenas de timestamps em blocos grandes.
create or replace function public.get_cloud_transcription_input(p_job_id uuid, p_worker_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  target public.processing_jobs%rowtype;
  chunk public.audio_chunks%rowtype;
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

  select c.title, c.topic, c.teacher_name, c.language, c.glossary, s.name as subject_name
  into context_row from public.classes c join public.subjects s on s.id = c.subject_id
  where c.id = target.class_id and c.deleted_at is null;
  select exists(
    select 1 from public.transcript_segments
    where chunk_id = chunk.id and transcript_version = target_version
  ) into already_persisted;
  return jsonb_build_object(
    'chunk_id', chunk.id, 'storage_path', chunk.storage_path, 'size_bytes', chunk.size_bytes,
    'duration_ms', chunk.end_ms - chunk.start_ms, 'language', context_row.language,
    'context', concat_ws(E'\n', context_row.subject_name, context_row.title,
      context_row.topic, context_row.teacher_name, context_row.glossary),
    'already_persisted', already_persisted
  );
end;
$$;

create or replace function public.persist_cloud_transcription(
  p_job_id uuid, p_worker_id text, p_segments jsonb, p_model_name text, p_duration_ms integer
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  target public.processing_jobs%rowtype;
  chunk public.audio_chunks%rowtype;
  segment_item jsonb;
  ordinal bigint;
  local_start bigint;
  local_end bigint;
  segment_text text;
  target_version integer;
  next_job_id uuid;
  completed_count integer;
  total_count integer;
  inserted_count integer := 0;
begin
  select * into target from public.processing_jobs where id = p_job_id for update;
  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id
     or target.job_type <> 'transcribe_chunk' then
    return jsonb_build_object('error_code', 'job_not_claimed');
  end if;
  target_version := coalesce((target.input_json ->> 'target_transcript_version')::integer, 1);
  select * into chunk from public.audio_chunks
  where id = (target.input_json ->> 'chunk_id')::uuid and class_id = target.class_id for update;
  if chunk.id is null then return jsonb_build_object('error_code', 'chunk_missing'); end if;

  if not exists(
    select 1 from public.transcript_segments
    where chunk_id = chunk.id and transcript_version = target_version
  ) then
    if jsonb_typeof(p_segments) <> 'array' or jsonb_array_length(p_segments) = 0 then
      return jsonb_build_object('error_code', 'no_speech');
    end if;
    for segment_item, ordinal in
      select value, ordinality from jsonb_array_elements(p_segments) with ordinality
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
        target.class_id, chunk.id, target_version,
        (chunk.chunk_index * 10000 + ordinal - 1)::integer,
        chunk.start_ms + local_start, chunk.start_ms + local_end,
        nullif(segment_item ->> 'speaker_label', ''), segment_text,
        case when segment_item ->> 'confidence' is null then null
             else (segment_item ->> 'confidence')::numeric end
      ) on conflict (class_id, transcript_version, sequence_number) do nothing;
      inserted_count := inserted_count + 1;
    end loop;
  end if;

  insert into public.usage_records (
    class_id, processing_job_id, provider, model_name, operation_type,
    audio_seconds, estimated_cost, duration_ms
  ) select target.class_id, target.id, 'cloudflare', left(p_model_name, 200),
      'transcription', (chunk.end_ms - chunk.start_ms) / 1000.0, 0, p_duration_ms
    where not exists (
      select 1 from public.usage_records
      where processing_job_id = target.id and operation_type = 'transcription'
    );

  select count(*)::integer into total_count from public.audio_chunks where class_id = target.class_id;
  select count(distinct chunk_id)::integer into completed_count
  from public.transcript_segments
  where class_id = target.class_id and transcript_version = target_version;
  if total_count > 0 and completed_count = total_count then
    insert into public.processing_jobs (
      class_id, user_id, job_type, status, stage, priority, max_attempts,
      idempotency_key, input_json
    ) values (
      target.class_id, target.user_id, 'assemble_transcript', 'pending', 'queued',
      target.priority, 8,
      'assemble_transcript:' || target.class_id::text || ':v' || target_version::text,
      jsonb_build_object('transcript_version', target_version, 'repair_transcript',
        coalesce((target.input_json ->> 'repair_transcript')::boolean, false))
    ) on conflict (idempotency_key) do update set next_attempt_at = now()
    returning id into next_job_id;
  end if;
  update public.classes set status = 'transcribing',
    progress = 20 + round((completed_count::numeric / greatest(total_count, 1)) * 50),
    current_stage = completed_count::text || ' de ' || total_count::text || ' blocos transcritos',
    error_message = null where id = target.class_id;
  return jsonb_build_object(
    'segments', inserted_count, 'chunks_completed', completed_count,
    'chunks_total', total_count, 'next_job_id', next_job_id, 'resumed', inserted_count = 0
  );
end;
$$;

create or replace function public.assemble_cloud_transcript(p_job_id uuid, p_worker_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  target public.processing_jobs%rowtype;
  target_version integer;
  segment_count integer;
  next_job_id uuid;
  was_resumed boolean;
begin
  select * into target from public.processing_jobs where id = p_job_id for update;
  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id
     or target.job_type <> 'assemble_transcript' then
    return jsonb_build_object('error_code', 'job_not_claimed');
  end if;
  target_version := coalesce((target.input_json ->> 'transcript_version')::integer, 1);
  select count(*)::integer into segment_count from public.transcript_segments
  where class_id = target.class_id and transcript_version = target_version;
  if segment_count = 0 then return jsonb_build_object('error_code', 'no_speech'); end if;
  select exists(select 1 from public.transcript_versions
    where class_id = target.class_id and version = target_version) into was_resumed;
  insert into public.transcript_versions (class_id, user_id, version, status, segment_count)
  values (target.class_id, target.user_id, target_version, 'assembled', segment_count)
  on conflict (class_id, version) do update set segment_count = excluded.segment_count;
  insert into public.processing_jobs (
    class_id, user_id, job_type, status, stage, priority, max_attempts,
    idempotency_key, input_json
  ) values (
    target.class_id, target.user_id, 'review_transcript', 'pending', 'queued',
    target.priority, 12,
    'review_transcript:' || target.class_id::text || ':v' || target_version::text,
    jsonb_build_object('transcript_version', target_version)
  ) on conflict (idempotency_key) do update set next_attempt_at = now()
  returning id into next_job_id;
  update public.classes set transcript_version = target_version, status = 'reviewing', progress = 72,
    current_stage = 'Revisando transcrição completa', error_message = null
  where id = target.class_id;
  return jsonb_build_object('version', target_version, 'segments', segment_count,
    'next_job_id', next_job_id, 'resumed', was_resumed);
end;
$$;

revoke all on function public.get_cloud_transcription_input(uuid, text) from public, anon, authenticated;
revoke all on function public.persist_cloud_transcription(uuid, text, jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.assemble_cloud_transcript(uuid, text) from public, anon, authenticated;
grant execute on function public.get_cloud_transcription_input(uuid, text) to service_role;
grant execute on function public.persist_cloud_transcription(uuid, text, jsonb, text, integer) to service_role;
grant execute on function public.assemble_cloud_transcript(uuid, text) to service_role;

-- Ao validar uma nova transcrição, reutiliza os materiais canônicos em vez de
-- criar versões visíveis ou jobs sem material.
create or replace function public.apply_cloud_global_review(
  p_job_id uuid, p_worker_id text, p_patches jsonb, p_checked_segments integer,
  p_model_name text, p_duration_ms integer, p_input_units integer default null,
  p_output_units integer default null, p_request_id text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  target public.processing_jobs%rowtype;
  review_version integer;
  total_count integer;
  patch jsonb;
  patch_id uuid;
  applied_count integer := 0;
  summary_material_id uuid;
  summary_job_id uuid;
begin
  select * into target from public.processing_jobs where id = p_job_id for update;
  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id
     or target.job_type <> 'review_transcript' or target.input_json ->> 'phase' <> 'global' then
    return jsonb_build_object('error_code', 'job_not_claimed');
  end if;
  if jsonb_typeof(p_patches) <> 'array' then
    return jsonb_build_object('error_code', 'invalid_review_response');
  end if;
  review_version := coalesce((target.input_json ->> 'transcript_version')::integer, 1);
  select count(*)::integer into total_count from public.transcript_segments
  where class_id = target.class_id and transcript_version = review_version;
  if total_count = 0 or p_checked_segments <> total_count then
    return jsonb_build_object('error_code', 'global_review_coverage_mismatch');
  end if;
  for patch in select value from jsonb_array_elements(p_patches) loop
    patch_id := (patch ->> 'segment_id')::uuid;
    update public.transcript_segments set revised_text = patch ->> 'revised_text',
      confidence = (patch ->> 'confidence')::numeric,
      review_status = 'auto_reviewed'::public.review_status
    where id = patch_id and class_id = target.class_id and transcript_version = review_version;
    if not found then return jsonb_build_object('error_code', 'global_review_segment_mismatch'); end if;
    applied_count := applied_count + 1;
  end loop;
  insert into public.usage_records (
    class_id, processing_job_id, provider, model_name, operation_type,
    input_units, output_units, estimated_cost, request_id, duration_ms
  ) select target.class_id, target.id, 'cloudflare', left(p_model_name, 200), 'review_global',
      p_input_units, p_output_units, 0, left(p_request_id, 200), p_duration_ms
    where not exists(select 1 from public.usage_records where processing_job_id = target.id);
  update public.transcript_versions set status = 'validated', segment_count = total_count
  where class_id = target.class_id and version = review_version;

  select id into summary_material_id from public.materials
  where class_id = target.class_id and material_type = 'summary';
  if summary_material_id is null then
    insert into public.materials (
      class_id, user_id, material_type, status, version,
      source_transcript_version, prompt_version, model_name
    ) values (
      target.class_id, target.user_id, 'summary', 'pending', 1,
      review_version, 'summary-current', 'provider-ranking'
    ) returning id into summary_material_id;
  else
    update public.materials set status = 'pending', source_transcript_version = review_version,
      structured_content = '{}'::jsonb, markdown_content = null, storage_path = null,
      prompt_version = 'summary-current', model_name = 'provider-ranking',
      error_message = null, updated_at = now()
    where id = summary_material_id;
  end if;
  insert into public.processing_jobs (
    class_id, user_id, job_type, status, stage, priority, max_attempts,
    idempotency_key, input_json
  ) values (
    target.class_id, target.user_id, 'generate_summary', 'pending', 'queued',
    target.priority, 12,
    'generate_summary:' || target.class_id::text || ':t' || review_version::text || ':auto',
    jsonb_build_object('material_id', summary_material_id, 'transcript_version', review_version)
  ) on conflict (idempotency_key) do update set next_attempt_at = now()
  returning id into summary_job_id;
  update public.materials set status = 'pending', source_transcript_version = review_version,
    structured_content = '{}'::jsonb, markdown_content = null, storage_path = null,
    error_message = null, updated_at = now()
  where class_id = target.class_id and material_type in ('notes','flashcards','questions','mindmap');
  update public.materials set status = 'failed', source_transcript_version = review_version,
    structured_content = '{}'::jsonb, storage_path = null,
    error_message = 'A transcrição foi atualizada. Gere o PDF novamente.', updated_at = now()
  where class_id = target.class_id and material_type = 'pdf';
  update public.classes set status = 'generating_materials', progress = 95,
    current_stage = 'Transcrição completa; preparando materiais', error_message = null
  where id = target.class_id;
  return jsonb_build_object('applied', applied_count, 'checked', total_count,
    'summary_job_id', summary_job_id);
end;
$$;

create or replace function public.finish_cloud_material(
  p_job_id uuid, p_worker_id text, p_structured_content jsonb, p_markdown_content text,
  p_model_name text, p_duration_ms integer, p_input_units integer default null,
  p_output_units integer default null, p_request_id text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  target public.processing_jobs%rowtype;
  material public.materials%rowtype;
  extra_type public.material_type;
  extra_material_id uuid;
  extra_job_type public.job_type;
begin
  select * into target from public.processing_jobs where id = p_job_id for update;
  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id then
    return jsonb_build_object('error_code', 'job_not_claimed');
  end if;
  select * into material from public.materials
  where id = (target.input_json ->> 'material_id')::uuid
    and class_id = target.class_id and user_id = target.user_id;
  if material.id is null then return jsonb_build_object('error_code', 'material_missing'); end if;
  update public.materials set status = 'completed', structured_content = p_structured_content,
    markdown_content = p_markdown_content, model_name = left(p_model_name, 200),
    error_message = null where id = material.id;
  insert into public.usage_records (
    class_id, processing_job_id, provider, model_name, operation_type,
    input_units, output_units, estimated_cost, request_id, duration_ms
  ) select target.class_id, target.id, 'cloudflare', left(p_model_name, 200),
      target.job_type::text, p_input_units, p_output_units, 0,
      left(p_request_id, 200), p_duration_ms
    where not exists(select 1 from public.usage_records where processing_job_id = target.id);
  update public.classes set status = 'completed', progress = 100,
    current_stage = case when material.material_type = 'summary'
      then 'Pronta para estudar' else 'Material pronto' end,
    study_ready_at = case when material.material_type = 'summary'
      then coalesce(study_ready_at, now()) else study_ready_at end,
    error_message = null where id = target.class_id;
  if material.material_type = 'summary' then
    foreach extra_type in array array[
      'notes'::public.material_type, 'flashcards'::public.material_type,
      'questions'::public.material_type, 'mindmap'::public.material_type
    ] loop
      select id into extra_material_id from public.materials
      where class_id = target.class_id and material_type = extra_type;
      if extra_material_id is null then
        insert into public.materials (
          class_id, user_id, material_type, status, version,
          source_transcript_version, prompt_version, model_name
        ) values (
          target.class_id, target.user_id, extra_type, 'pending', 1,
          material.source_transcript_version, 'current', 'provider-ranking'
        ) returning id into extra_material_id;
      else
        update public.materials set status = 'pending',
          source_transcript_version = material.source_transcript_version,
          structured_content = '{}'::jsonb, markdown_content = null,
          prompt_version = 'current', model_name = 'provider-ranking',
          error_message = null, updated_at = now()
        where id = extra_material_id;
      end if;
      extra_job_type := ('generate_' || extra_type::text)::public.job_type;
      insert into public.processing_jobs (
        class_id, user_id, job_type, status, stage, priority, max_attempts,
        idempotency_key, input_json
      ) values (
        target.class_id, target.user_id, extra_job_type, 'pending', 'queued',
        greatest(target.priority - 20, 0), 12,
        extra_job_type::text || ':' || target.class_id::text || ':t' ||
          material.source_transcript_version::text || ':auto',
        jsonb_build_object('material_id', extra_material_id,
          'transcript_version', material.source_transcript_version, 'automatic', true)
      ) on conflict (idempotency_key) do update set next_attempt_at = now();
    end loop;
  end if;
  return jsonb_build_object('material_id', material.id, 'completed', true);
end;
$$;

revoke all on function public.apply_cloud_global_review(uuid, text, jsonb, integer, text, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.apply_cloud_global_review(uuid, text, jsonb, integer, text, integer, integer, integer, text)
  to service_role;
