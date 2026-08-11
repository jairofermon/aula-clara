-- Aceita falas sem valor acadêmico descartadas explicitamente pelo ChatGPT.
-- O segmento, o timestamp e o raw_text permanecem preservados; apenas revised_text
-- pode ficar vazio, fazendo a leitura final omitir a fala descartável.

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
  discarded_segments integer;
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
      or jsonb_typeof(item.value -> 'revised_text') is distinct from 'string'
      or jsonb_typeof(item.value -> 'confidence') is distinct from 'number'
      or (item.value ->> 'confidence')::numeric not between 0 and 1
      or item.value ->> 'disposition' is not null
         and item.value ->> 'disposition' not in ('keep', 'discard')
      or (item.value ->> 'disposition') = 'keep'
         and length(trim(item.value ->> 'revised_text')) = 0
      or (item.value ->> 'disposition') = 'discard'
         and length(trim(item.value ->> 'revised_text')) > 0
  ) then
    raise exception 'segment_coverage_mismatch';
  end if;

  select count(*)::integer into discarded_segments
  from jsonb_array_elements(p_segments) item
  where length(trim(item.value ->> 'revised_text')) = 0;

  update public.transcript_segments segment
  set revised_text = imported.revised_text,
      confidence = imported.confidence,
      review_status = 'auto_reviewed',
      user_confirmed = false,
      updated_at = now()
  from jsonb_to_recordset(p_segments)
    as imported(segment_id uuid, revised_text text, confidence numeric, disposition text)
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
        prompt_version = 'chatgpt-manual-v2',
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
        'chatgpt-manual-v2', left(p_model_name, 120)
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
      'discarded_segments', discarded_segments,
      'materials', imported_materials,
      'model_name', left(p_model_name, 120),
      'reasoning_effort', left(p_reasoning_effort, 20)
    )
  );
  return jsonb_build_object(
    'imported', true,
    'segments', expected_segments,
    'discarded_segments', discarded_segments,
    'materials', imported_materials
  );
end;
$$;

revoke all on function public.import_chatgpt_package(uuid, integer, jsonb, jsonb, text, text)
  from public, anon;
grant execute on function public.import_chatgpt_package(uuid, integer, jsonb, jsonb, text, text)
  to authenticated;
