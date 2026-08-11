-- O fluxo principal passa a encerrar após a transcrição bruta. A revisão
-- profunda e os materiais podem ser importados em uma única operação atômica.

create or replace function public.assemble_cloud_transcript(p_job_id uuid, p_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.processing_jobs%rowtype;
  target_version integer;
  segment_count integer;
  was_resumed boolean;
begin
  select * into target from public.processing_jobs where id = p_job_id for update;
  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id
     or target.job_type <> 'assemble_transcript' then
    return jsonb_build_object('error_code', 'job_not_claimed');
  end if;
  target_version := coalesce((target.input_json ->> 'transcript_version')::integer, 1);
  select count(*)::integer into segment_count
  from public.transcript_segments
  where class_id = target.class_id and transcript_version = target_version;
  if segment_count = 0 then
    return jsonb_build_object('error_code', 'no_speech');
  end if;
  select exists(
    select 1 from public.transcript_versions
    where class_id = target.class_id and version = target_version
  ) into was_resumed;
  insert into public.transcript_versions (class_id, user_id, version, status, segment_count)
  values (target.class_id, target.user_id, target_version, 'assembled', segment_count)
  on conflict (class_id, version) do update
  set status = 'assembled', segment_count = excluded.segment_count;
  update public.classes
  set transcript_version = target_version,
      status = 'needs_user_review',
      progress = 72,
      current_stage = 'Transcrição bruta pronta para o ChatGPT',
      error_message = null,
      updated_at = now()
  where id = target.class_id;
  return jsonb_build_object(
    'version', target_version,
    'segments', segment_count,
    'next_job_id', null,
    'raw_transcript_ready', true,
    'resumed', was_resumed
  );
end;
$$;

revoke all on function public.assemble_cloud_transcript(uuid, text) from public, anon, authenticated;
grant execute on function public.assemble_cloud_transcript(uuid, text) to service_role;

create or replace function public.import_chatgpt_package(
  p_class_id uuid,
  p_transcript_version integer,
  p_segments jsonb,
  p_materials jsonb,
  p_model_name text,
  p_reasoning_effort text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.classes%rowtype;
  expected_segments integer;
  received_segments integer;
  distinct_segments integer;
  material_item jsonb;
  material_type_text text;
  imported_materials integer := 0;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  select * into target from public.classes
  where id = p_class_id and deleted_at is null for update;
  if target.id is null then raise exception 'class_not_found'; end if;
  if target.user_id <> auth.uid() and not public.is_admin() then
    raise exception 'forbidden';
  end if;
  if target.transcript_version <> p_transcript_version then
    raise exception 'transcript_version_mismatch';
  end if;
  if jsonb_typeof(p_segments) <> 'array' or jsonb_typeof(p_materials) <> 'array' then
    raise exception 'invalid_package_shape';
  end if;

  select count(*)::integer into expected_segments
  from public.transcript_segments
  where class_id = p_class_id and transcript_version = p_transcript_version;
  select count(*)::integer,
         count(distinct value ->> 'segment_id')::integer
  into received_segments, distinct_segments
  from jsonb_array_elements(p_segments);
  if expected_segments = 0 or received_segments <> expected_segments
     or distinct_segments <> expected_segments then
    raise exception 'segment_coverage_mismatch';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_segments) item
    left join public.transcript_segments segment
      on segment.id = (item.value ->> 'segment_id')::uuid
     and segment.class_id = p_class_id
     and segment.transcript_version = p_transcript_version
    where segment.id is null
      or length(trim(coalesce(item.value ->> 'revised_text', ''))) = 0
      or (item.value ->> 'confidence')::numeric not between 0 and 1
  ) then
    raise exception 'segment_coverage_mismatch';
  end if;

  update public.transcript_segments segment
  set revised_text = imported.revised_text,
      confidence = imported.confidence,
      review_status = 'auto_reviewed',
      user_confirmed = false,
      updated_at = now()
  from jsonb_to_recordset(p_segments)
    as imported(segment_id uuid, revised_text text, confidence numeric)
  where segment.id = imported.segment_id
    and segment.class_id = p_class_id
    and segment.transcript_version = p_transcript_version;

  delete from public.transcript_issues issue
  using public.transcript_segments segment
  where issue.transcript_segment_id = segment.id
    and segment.class_id = p_class_id
    and segment.transcript_version = p_transcript_version;

  update public.transcript_versions
  set status = 'validated', segment_count = expected_segments
  where class_id = p_class_id and version = p_transcript_version;

  if jsonb_array_length(p_materials) <> 5
     or (select count(distinct value ->> 'material_type') from jsonb_array_elements(p_materials)) <> 5 then
    raise exception 'material_coverage_mismatch';
  end if;
  for material_item in select value from jsonb_array_elements(p_materials)
  loop
    material_type_text := material_item ->> 'material_type';
    if material_type_text not in ('notes', 'summary', 'flashcards', 'questions', 'mindmap')
       or jsonb_typeof(material_item -> 'structured_content') <> 'object' then
      raise exception 'invalid_material';
    end if;
    update public.materials
    set status = 'completed',
        version = 1,
        source_transcript_version = p_transcript_version,
        structured_content = material_item -> 'structured_content',
        markdown_content = null,
        storage_path = null,
        prompt_version = 'chatgpt-manual-v1',
        model_name = left(p_model_name, 120),
        error_message = null,
        updated_at = now()
    where class_id = p_class_id
      and material_type = material_type_text::public.material_type;
    if not found then
      insert into public.materials (
        class_id, user_id, material_type, status, version,
        source_transcript_version, structured_content, prompt_version, model_name
      ) values (
        p_class_id, target.user_id, material_type_text::public.material_type, 'completed', 1,
        p_transcript_version, material_item -> 'structured_content',
        'chatgpt-manual-v1', left(p_model_name, 120)
      );
    end if;
    imported_materials := imported_materials + 1;
  end loop;

  update public.processing_jobs
  set status = 'cancelled',
      stage = 'superseded_by_chatgpt_import',
      locked_at = null,
      locked_by = null,
      finished_at = now(),
      error_code = null,
      error_message = null,
      updated_at = now()
  where class_id = p_class_id
    and status in ('pending', 'running', 'retry_wait')
    and job_type in (
      'review_transcript', 'generate_notes', 'generate_summary',
      'generate_flashcards', 'generate_questions', 'generate_mindmap'
    );

  update public.classes
  set status = 'completed',
      progress = 100,
      current_stage = 'Revisão e materiais importados do ChatGPT',
      error_message = null,
      study_ready_at = coalesce(study_ready_at, now()),
      updated_at = now()
  where id = p_class_id;

  insert into public.usage_records (
    class_id, provider, model_name, operation_type,
    input_units, output_units, estimated_cost, request_id
  ) values (
    p_class_id, 'chatgpt-manual', left(p_model_name, 120),
    'manual_package_import:' || left(p_reasoning_effort, 20), 0, 0, 0,
    'manual:' || gen_random_uuid()::text
  );
  insert into public.audit_events (
    user_id, class_id, action, resource_type, resource_id, metadata
  ) values (
    auth.uid(), p_class_id, 'chatgpt_package_imported', 'class', p_class_id,
    jsonb_build_object(
      'transcript_version', p_transcript_version,
      'segments', expected_segments,
      'materials', imported_materials,
      'model_name', left(p_model_name, 120),
      'reasoning_effort', left(p_reasoning_effort, 20)
    )
  );
  return jsonb_build_object(
    'imported', true,
    'segments', expected_segments,
    'materials', imported_materials
  );
end;
$$;

revoke all on function public.import_chatgpt_package(uuid, integer, jsonb, jsonb, text, text)
  from public, anon;
grant execute on function public.import_chatgpt_package(uuid, integer, jsonb, jsonb, text, text)
  to authenticated;

-- Libera imediatamente aulas que estavam presas na revisão gratuita.
with affected as (
  select id, transcript_version
  from public.classes
  where status = 'reviewing' and transcript_version > 0 and deleted_at is null
), cancelled as (
  update public.processing_jobs job
  set status = 'cancelled',
      stage = 'manual_chatgpt_workflow_enabled',
      locked_at = null,
      locked_by = null,
      finished_at = now(),
      error_code = null,
      error_message = null,
      updated_at = now()
  from affected
  where job.class_id = affected.id
    and job.status in ('pending', 'running', 'retry_wait')
    and job.job_type = 'review_transcript'
  returning job.class_id
)
update public.classes class
set status = 'needs_user_review',
    progress = 72,
    current_stage = 'Transcrição bruta pronta para o ChatGPT',
    error_message = null,
    updated_at = now()
from affected
where class.id = affected.id;

