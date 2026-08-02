create or replace function public.get_cloud_review_batch(
  p_job_id uuid,
  p_worker_id text,
  p_limit integer default 12
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.processing_jobs%rowtype;
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
      and transcript_version = 1
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
  segment_item jsonb;
  issue_item jsonb;
  segment_id uuid;
  needs_review boolean;
  applied_count integer := 0;
  remaining_count integer;
  needs_review_count integer;
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

  for segment_item in select value from jsonb_array_elements(p_segments)
  loop
    segment_id := (segment_item ->> 'segment_id')::uuid;
    needs_review := (segment_item ->> 'needs_review')::boolean;

    update public.transcript_segments
    set revised_text = segment_item ->> 'revised_text',
        confidence = (segment_item ->> 'confidence')::numeric,
        review_status = case
          when needs_review then 'needs_review'::public.review_status
          else 'auto_reviewed'::public.review_status
        end
    where id = segment_id
      and class_id = target.class_id
      and transcript_version = 1
      and review_status = 'unreviewed';

    if not found then
      return jsonb_build_object('error_code', 'review_segment_conflict');
    end if;
    applied_count := applied_count + 1;

    for issue_item in
      select value from jsonb_array_elements(coalesce(segment_item -> 'issues', '[]'::jsonb))
    loop
      insert into public.transcript_issues (
        class_id, transcript_segment_id, issue_type, description,
        proposed_text, confidence
      ) values (
        target.class_id,
        segment_id,
        issue_item ->> 'type',
        issue_item ->> 'description',
        nullif(issue_item ->> 'proposed_text', ''),
        (segment_item ->> 'confidence')::numeric
      );
    end loop;
  end loop;

  insert into public.usage_records (
    class_id, processing_job_id, provider, model_name, operation_type,
    input_units, output_units, estimated_cost, request_id, duration_ms
  ) values (
    target.class_id, target.id, 'cloudflare', left(p_model_name, 200), 'review',
    p_input_units, p_output_units, 0, left(p_request_id, 200), p_duration_ms
  );

  select count(*) filter (where review_status = 'unreviewed')::integer,
         count(*) filter (where review_status = 'needs_review')::integer
  into remaining_count, needs_review_count
  from public.transcript_segments
  where class_id = target.class_id and transcript_version = 1;

  if remaining_count = 0 then
    update public.classes
    set status = case
          when needs_review_count > 0 then 'needs_user_review'::public.class_status
          else 'completed'::public.class_status
        end,
        progress = case when needs_review_count > 0 then 85 else 100 end,
        current_stage = case
          when needs_review_count > 0 then 'Aguardando conferência'
          else 'Transcrição validada'
        end,
        error_message = null
    where id = target.class_id;

    update public.transcript_versions
    set status = case when needs_review_count > 0 then 'reviewed' else 'validated' end
    where class_id = target.class_id and version = 1;
  else
    update public.classes
    set status = 'reviewing',
        progress = least(84, 72 + applied_count),
        current_stage = remaining_count::text || ' segmentos aguardando revisão'
    where id = target.class_id;
  end if;

  return jsonb_build_object(
    'applied', applied_count,
    'remaining', remaining_count,
    'needs_review', needs_review_count
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
  open_issue_count integer;
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

  select count(*)::integer into open_issue_count
  from public.transcript_issues
  where class_id = target.class_id and status = 'open';

  select count(*)::integer into unreviewed_count
  from public.transcript_segments
  where class_id = target.class_id
    and transcript_version = material.source_transcript_version
    and review_status in ('unreviewed', 'needs_review');

  if open_issue_count > 0 or unreviewed_count > 0 then
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

create or replace function public.finish_cloud_material(
  p_job_id uuid,
  p_worker_id text,
  p_structured_content jsonb,
  p_markdown_content text,
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
  material_id uuid;
begin
  select * into target
  from public.processing_jobs
  where id = p_job_id
  for update;

  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id then
    return jsonb_build_object('error_code', 'job_not_claimed');
  end if;

  material_id := (target.input_json ->> 'material_id')::uuid;
  update public.materials
  set status = 'completed',
      structured_content = p_structured_content,
      markdown_content = p_markdown_content,
      model_name = left(p_model_name, 200),
      error_message = null
  where id = material_id
    and class_id = target.class_id
    and user_id = target.user_id;

  if not found then
    return jsonb_build_object('error_code', 'material_missing');
  end if;

  insert into public.usage_records (
    class_id, processing_job_id, provider, model_name, operation_type,
    input_units, output_units, estimated_cost, request_id, duration_ms
  )
  select target.class_id, target.id, 'cloudflare', left(p_model_name, 200),
         target.job_type::text, p_input_units, p_output_units, 0,
         left(p_request_id, 200), p_duration_ms
  where not exists (
    select 1 from public.usage_records where processing_job_id = target.id
  );

  update public.classes
  set status = 'completed', progress = 100,
      current_stage = 'Material pronto', error_message = null
  where id = target.class_id;

  return jsonb_build_object('material_id', material_id, 'completed', true);
end;
$$;

revoke all on function public.get_cloud_review_batch(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.apply_cloud_review_batch(uuid, text, jsonb, text, integer, integer, integer, text)
  from public, anon, authenticated;
revoke all on function public.get_cloud_material_input(uuid, text)
  from public, anon, authenticated;
revoke all on function public.finish_cloud_material(uuid, text, jsonb, text, text, integer, integer, integer, text)
  from public, anon, authenticated;

grant execute on function public.get_cloud_review_batch(uuid, text, integer)
  to service_role;
grant execute on function public.apply_cloud_review_batch(uuid, text, jsonb, text, integer, integer, integer, text)
  to service_role;
grant execute on function public.get_cloud_material_input(uuid, text)
  to service_role;
grant execute on function public.finish_cloud_material(uuid, text, jsonb, text, text, integer, integer, integer, text)
  to service_role;
