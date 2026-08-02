create or replace function public.build_compact_transcript_version(
  p_class_id uuid,
  p_user_id uuid,
  p_source_version integer,
  p_target_version integer,
  p_group_size integer default 12
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  compact_count integer;
begin
  if p_source_version < 1 or p_target_version <= p_source_version then
    raise exception 'invalid transcript versions';
  end if;

  if not exists (
    select 1 from public.transcript_segments
    where class_id = p_class_id and transcript_version = p_target_version
  ) then
    insert into public.transcript_segments (
      class_id, chunk_id, transcript_version, sequence_number,
      start_ms, end_ms, speaker_label, raw_text, confidence, review_status
    )
    with ordered as (
      select s.*,
             row_number() over (order by s.sequence_number) - 1 as row_index
      from public.transcript_segments s
      where s.class_id = p_class_id
        and s.transcript_version = p_source_version
    ), compact as (
      select (row_index / greatest(2, least(p_group_size, 30)))::integer as group_index,
             min(start_ms) as start_ms,
             max(end_ms) as end_ms,
             string_agg(
               coalesce(nullif(btrim(revised_text), ''), raw_text),
               ' ' order by sequence_number
             ) as source_text,
             avg(confidence) as confidence
      from ordered
      group by (row_index / greatest(2, least(p_group_size, 30)))::integer
    )
    select p_class_id, null, p_target_version, group_index,
           start_ms, end_ms, null, btrim(source_text), confidence, 'unreviewed'
    from compact
    where btrim(source_text) <> ''
    order by group_index;
  end if;

  select count(*)::integer into compact_count
  from public.transcript_segments
  where class_id = p_class_id and transcript_version = p_target_version;

  insert into public.transcript_versions (
    class_id, user_id, version, status, segment_count
  ) values (
    p_class_id, p_user_id, p_target_version, 'assembled', compact_count
  )
  on conflict (class_id, version) do update
    set segment_count = excluded.segment_count;

  return compact_count;
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
  review_count integer;
  review_version integer := 1;
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

  review_count := segment_count;
  if segment_count > 200 then
    review_version := 2;
    review_count := public.build_compact_transcript_version(
      target.class_id, target.user_id, 1, review_version, 12
    );
  end if;

  insert into public.processing_jobs (
    class_id, user_id, job_type, status, stage, idempotency_key, input_json
  ) values (
    target.class_id, target.user_id, 'review_transcript', 'pending', 'queued',
    'review_transcript:' || target.class_id::text || ':v' || review_version::text,
    jsonb_build_object('transcript_version', review_version)
  )
  on conflict (idempotency_key) do update
    set idempotency_key = excluded.idempotency_key
  returning id into next_job_id;

  update public.classes
  set transcript_version = review_version,
      status = 'reviewing',
      progress = 72,
      current_stage = 'Corrigindo transcrição automaticamente',
      error_message = null
  where id = target.class_id;

  return jsonb_build_object(
    'version', review_version,
    'segments', review_count,
    'next_job_id', next_job_id,
    'resumed', was_resumed
  );
end;
$$;

create or replace function public.get_cloud_review_batch(
  p_job_id uuid,
  p_worker_id text,
  p_limit integer default 24
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.processing_jobs%rowtype;
  review_version integer;
  batch jsonb;
  context_text text;
begin
  select * into target
  from public.processing_jobs
  where id = p_job_id;

  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id
     or target.job_type <> 'review_transcript' then
    return jsonb_build_object('error_code', 'job_not_claimed');
  end if;

  review_version := coalesce((target.input_json ->> 'transcript_version')::integer, 1);

  select coalesce(jsonb_agg(item order by sequence_number), '[]'::jsonb)
  into batch
  from (
    select sequence_number, jsonb_build_object(
      'segment_id', id,
      'raw_text', raw_text,
      'start_ms', start_ms,
      'end_ms', end_ms
    ) as item
    from public.transcript_segments
    where class_id = target.class_id
      and transcript_version = review_version
      and review_status = 'unreviewed'
    order by sequence_number
    limit greatest(1, least(p_limit, 30))
  ) selected;

  select left(concat_ws(E'\n', s.name, c.title, c.topic, c.teacher_name, c.glossary), 8000)
  into context_text
  from public.classes c
  join public.subjects s on s.id = c.subject_id
  where c.id = target.class_id;

  return jsonb_build_object('segments', batch, 'context', coalesce(context_text, ''));
end;
$$;

create or replace function public.apply_cloud_review_batch(
  p_job_id uuid,
  p_worker_id text,
  p_segments jsonb,
  p_model_name text,
  p_duration_ms integer,
  p_input_units integer default null,
  p_output_units integer default null,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.processing_jobs%rowtype;
  review_version integer;
  segment_item jsonb;
  segment_id uuid;
  applied_count integer := 0;
  remaining_count integer;
  total_count integer;
begin
  select * into target
  from public.processing_jobs
  where id = p_job_id
  for update;

  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id
     or target.job_type <> 'review_transcript' then
    return jsonb_build_object('error_code', 'job_not_claimed');
  end if;
  if jsonb_typeof(p_segments) <> 'array' or jsonb_array_length(p_segments) = 0 then
    return jsonb_build_object('error_code', 'invalid_review_response');
  end if;

  review_version := coalesce((target.input_json ->> 'transcript_version')::integer, 1);

  for segment_item in select value from jsonb_array_elements(p_segments)
  loop
    segment_id := (segment_item ->> 'segment_id')::uuid;

    update public.transcript_segments
    set revised_text = segment_item ->> 'revised_text',
        confidence = (segment_item ->> 'confidence')::numeric,
        review_status = 'auto_reviewed'::public.review_status,
        user_confirmed = false
    where id = segment_id
      and class_id = target.class_id
      and transcript_version = review_version
      and review_status = 'unreviewed';

    if not found then
      return jsonb_build_object('error_code', 'review_segment_conflict');
    end if;
    applied_count := applied_count + 1;
  end loop;

  insert into public.usage_records (
    class_id, processing_job_id, provider, model_name, operation_type,
    input_units, output_units, estimated_cost, request_id, duration_ms
  ) values (
    target.class_id, target.id, 'cloudflare', left(p_model_name, 200), 'review',
    p_input_units, p_output_units, 0, left(p_request_id, 200), p_duration_ms
  );

  select count(*) filter (where review_status = 'unreviewed')::integer,
         count(*)::integer
  into remaining_count, total_count
  from public.transcript_segments
  where class_id = target.class_id and transcript_version = review_version;

  if remaining_count = 0 then
    update public.classes
    set status = 'completed', progress = 100,
        current_stage = 'Transcrição corrigida', error_message = null
    where id = target.class_id;

    update public.transcript_versions
    set status = 'validated', segment_count = total_count
    where class_id = target.class_id and version = review_version;
  else
    update public.classes
    set status = 'reviewing',
        progress = least(99, 72 + round(
          ((total_count - remaining_count)::numeric / greatest(total_count, 1)) * 27
        )),
        current_stage = 'Correção automática: ' ||
          (total_count - remaining_count)::text || ' de ' || total_count::text || ' trechos',
        error_message = null
    where id = target.class_id;
  end if;

  return jsonb_build_object(
    'applied', applied_count,
    'remaining', remaining_count,
    'needs_review', 0
  );
end;
$$;

create or replace function public.get_cloud_material_input(
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
  material public.materials%rowtype;
  material_id uuid;
  transcript jsonb;
  class_context jsonb;
  unreviewed_count integer;
begin
  select * into target
  from public.processing_jobs
  where id = p_job_id
  for update;

  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id
     or target.job_type::text not like 'generate_%' then
    return jsonb_build_object('error_code', 'job_not_claimed');
  end if;

  begin
    material_id := (target.input_json ->> 'material_id')::uuid;
  exception when others then
    return jsonb_build_object('error_code', 'invalid_material');
  end;

  select * into material
  from public.materials
  where id = material_id
    and class_id = target.class_id
    and user_id = target.user_id;

  if material.id is null then
    return jsonb_build_object('error_code', 'material_missing');
  end if;
  if material.status = 'completed' then
    return jsonb_build_object(
      'material_id', material.id,
      'material_type', material.material_type,
      'source_transcript_version', material.source_transcript_version,
      'transcript', '[]'::jsonb,
      'class_context', '{}'::jsonb,
      'already_completed', true
    );
  end if;

  select count(*)::integer into unreviewed_count
  from public.transcript_segments
  where class_id = target.class_id
    and transcript_version = material.source_transcript_version
    and review_status = 'unreviewed';

  if unreviewed_count > 0 then
    return jsonb_build_object('error_code', 'review_required');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'segment_id', id,
    'start_ms', start_ms,
    'end_ms', end_ms,
    'speaker_label', speaker_label,
    'text', coalesce(revised_text, raw_text)
  ) order by sequence_number), '[]'::jsonb)
  into transcript
  from public.transcript_segments
  where class_id = target.class_id
    and transcript_version = material.source_transcript_version;

  if jsonb_array_length(transcript) = 0 then
    return jsonb_build_object('error_code', 'transcript_missing');
  end if;

  select jsonb_build_object(
    'title', c.title,
    'topic', c.topic,
    'teacher_name', c.teacher_name,
    'class_date', c.class_date,
    'language', c.language,
    'subject_name', s.name
  )
  into class_context
  from public.classes c
  join public.subjects s on s.id = c.subject_id
  where c.id = target.class_id;

  update public.materials
  set status = 'generating', error_message = null
  where id = material.id;

  return jsonb_build_object(
    'material_id', material.id,
    'material_type', material.material_type,
    'source_transcript_version', material.source_transcript_version,
    'transcript', transcript,
    'class_context', class_context,
    'already_completed', false
  );
end;
$$;

do $$
declare
  target record;
  compact_count integer;
begin
  for target in
    select c.id, c.user_id
    from public.classes c
    where c.deleted_at is null
      and c.transcript_version = 1
      and (
        select count(*) from public.transcript_segments s
        where s.class_id = c.id and s.transcript_version = 1
      ) > 200
  loop
    compact_count := public.build_compact_transcript_version(
      target.id, target.user_id, 1, 2, 12
    );

    update public.processing_jobs
    set status = 'completed', stage = 'superseded', progress = 100,
        finished_at = now(), locked_at = null, locked_by = null,
        output_json = coalesce(output_json, '{}'::jsonb) ||
          jsonb_build_object('superseded_by_transcript_version', 2)
    where class_id = target.id
      and job_type = 'review_transcript'
      and status in ('pending', 'running', 'retry_wait', 'failed');

    insert into public.processing_jobs (
      class_id, user_id, job_type, status, stage, progress,
      attempt_count, max_attempts, next_attempt_at, idempotency_key, input_json
    ) values (
      target.id, target.user_id, 'review_transcript', 'pending', 'queued', 0,
      0, 12, now(), 'review_transcript:' || target.id::text || ':v2',
      jsonb_build_object('transcript_version', 2)
    )
    on conflict (idempotency_key) do update
      set status = 'pending', stage = 'queued', progress = 0,
          attempt_count = 0,
          max_attempts = greatest(public.processing_jobs.max_attempts, 12),
          next_attempt_at = now(), finished_at = null,
          locked_at = null, locked_by = null,
          error_code = null, error_message = null,
          input_json = excluded.input_json;

    update public.transcript_issues
    set status = 'resolved', resolved_at = coalesce(resolved_at, now())
    where class_id = target.id and status = 'open';

    update public.classes
    set transcript_version = 2, status = 'queued', progress = 72,
        current_stage = 'Correção automática na fila', error_message = null
    where id = target.id;
  end loop;
end;
$$;

update public.transcript_segments
set review_status = 'auto_reviewed'::public.review_status
where review_status = 'needs_review'
  and revised_text is not null;

update public.transcript_issues
set status = 'resolved', resolved_at = coalesce(resolved_at, now())
where status = 'open';

update public.classes c
set status = 'completed', progress = 100,
    current_stage = 'Transcrição corrigida', error_message = null
where c.deleted_at is null
  and c.transcript_version > 0
  and c.status = 'needs_user_review'
  and not exists (
    select 1 from public.transcript_segments s
    where s.class_id = c.id
      and s.transcript_version = c.transcript_version
      and s.review_status = 'unreviewed'
  );

revoke all on function public.build_compact_transcript_version(uuid, uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.build_compact_transcript_version(uuid, uuid, integer, integer, integer)
  to service_role;
