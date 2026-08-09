alter table public.classes
  add column if not exists processing_priority smallint not null default 50
    check (processing_priority between 0 and 100),
  add column if not exists processing_started_at timestamptz,
  add column if not exists target_ready_at timestamptz,
  add column if not exists study_ready_at timestamptz;

alter table public.processing_jobs
  add column if not exists priority smallint not null default 50
    check (priority between 0 and 100);

create index if not exists jobs_priority_ready_idx
  on public.processing_jobs(status, priority desc, next_attempt_at, created_at);

create or replace function public.inherit_processing_job_priority()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.priority = 50 then
    select processing_priority into new.priority
    from public.classes
    where id = new.class_id;
    new.priority := coalesce(new.priority, 50);
  end if;
  return new;
end;
$$;

drop trigger if exists processing_jobs_inherit_priority on public.processing_jobs;
create trigger processing_jobs_inherit_priority
before insert on public.processing_jobs
for each row execute function public.inherit_processing_job_priority();

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
        or (j.status = 'running'
            and j.locked_at < now() - make_interval(secs => p_lock_ttl_seconds))
      )
      and not exists (
        select 1 from public.processing_jobs higher
        where higher.user_id = j.user_id
          and higher.priority > j.priority
          and higher.attempt_count < higher.max_attempts
          and higher.next_attempt_at <= now()
          and higher.status in ('pending', 'retry_wait')
      )
    for update skip locked
  )
  update public.processing_jobs j
  set status = 'running', locked_by = p_worker_id, locked_at = now(),
      started_at = coalesce(j.started_at, now()), attempt_count = j.attempt_count + 1,
      error_code = null, error_message = null
  from candidate where j.id = candidate.id
  returning j.*;
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
  next_job_id uuid;
begin
  select * into target from public.processing_jobs where id = p_job_id for update;
  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id
     or target.job_type <> 'review_transcript'
     or coalesce(target.input_json ->> 'phase', 'segments') <> 'segments' then
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
    where id = segment_id and class_id = target.class_id
      and transcript_version = review_version and review_status = 'unreviewed';
    if not found then return jsonb_build_object('error_code', 'review_segment_conflict'); end if;
    applied_count := applied_count + 1;
  end loop;

  insert into public.usage_records (
    class_id, processing_job_id, provider, model_name, operation_type,
    input_units, output_units, estimated_cost, request_id, duration_ms
  ) values (
    target.class_id, target.id, 'cloudflare', left(p_model_name, 200), 'review_segments',
    p_input_units, p_output_units, 0, left(p_request_id, 200), p_duration_ms
  );

  select count(*) filter (where review_status = 'unreviewed')::integer, count(*)::integer
  into remaining_count, total_count
  from public.transcript_segments
  where class_id = target.class_id and transcript_version = review_version;

  if remaining_count = 0 then
    insert into public.processing_jobs (
      class_id, user_id, job_type, status, stage, priority, max_attempts,
      idempotency_key, input_json
    ) values (
      target.class_id, target.user_id, 'review_transcript', 'pending', 'queued',
      target.priority, 12,
      'review_transcript:' || target.class_id::text || ':v' || review_version::text || ':global',
      jsonb_build_object('transcript_version', review_version, 'phase', 'global')
    )
    on conflict (idempotency_key) do update
      set status = case when public.processing_jobs.status = 'completed'
                        then public.processing_jobs.status else 'pending'::public.job_status end,
          stage = case when public.processing_jobs.status = 'completed'
                       then public.processing_jobs.stage else 'queued' end,
          next_attempt_at = case when public.processing_jobs.status = 'completed'
                                 then public.processing_jobs.next_attempt_at else now() end,
          error_code = null, error_message = null
    returning id into next_job_id;

    update public.transcript_versions
    set status = 'reviewed', segment_count = total_count
    where class_id = target.class_id and version = review_version;

    update public.classes
    set status = 'reviewing', progress = 90,
        current_stage = 'Fazendo revisão final da aula completa', error_message = null
    where id = target.class_id;
  else
    update public.classes
    set status = 'reviewing',
        progress = least(89, 72 + round(
          ((total_count - remaining_count)::numeric / greatest(total_count, 1)) * 17
        )),
        current_stage = 'Primeira revisão: ' ||
          (total_count - remaining_count)::text || ' de ' || total_count::text || ' trechos',
        error_message = null
    where id = target.class_id;
  end if;

  return jsonb_build_object(
    'applied', applied_count, 'remaining', remaining_count,
    'needs_review', 0, 'next_job_id', next_job_id
  );
end;
$$;

create or replace function public.get_cloud_global_review_input(
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
  review_version integer;
  transcript jsonb;
  context_text text;
  summary_job_id uuid;
  version_status text;
begin
  select * into target from public.processing_jobs where id = p_job_id;
  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id
     or target.job_type <> 'review_transcript'
     or target.input_json ->> 'phase' <> 'global' then
    return jsonb_build_object('error_code', 'job_not_claimed');
  end if;
  review_version := coalesce((target.input_json ->> 'transcript_version')::integer, 1);
  select status into version_status from public.transcript_versions
  where class_id = target.class_id and version = review_version;
  if version_status = 'validated' then
    select id into summary_job_id from public.processing_jobs
    where idempotency_key = 'generate_summary:' || target.class_id::text ||
      ':t' || review_version::text || ':auto';
    return jsonb_build_object(
      'segments', '[]'::jsonb, 'context', '', 'already_completed', true,
      'summary_job_id', summary_job_id
    );
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'segment_id', id, 'raw_text', coalesce(revised_text, raw_text),
    'start_ms', start_ms, 'end_ms', end_ms
  ) order by sequence_number), '[]'::jsonb)
  into transcript
  from public.transcript_segments
  where class_id = target.class_id and transcript_version = review_version
    and review_status <> 'unreviewed';

  select left(concat_ws(E'\n', s.name, c.title, c.topic, c.teacher_name, c.glossary), 12000)
  into context_text
  from public.classes c join public.subjects s on s.id = c.subject_id
  where c.id = target.class_id;

  return jsonb_build_object(
    'segments', transcript, 'context', coalesce(context_text, ''),
    'already_completed', false, 'summary_job_id', null
  );
end;
$$;

create or replace function public.apply_cloud_global_review(
  p_job_id uuid,
  p_worker_id text,
  p_patches jsonb,
  p_checked_segments integer,
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
  total_count integer;
  patch jsonb;
  patch_id uuid;
  applied_count integer := 0;
  summary_material_id uuid;
  summary_job_id uuid;
begin
  select * into target from public.processing_jobs where id = p_job_id for update;
  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id
     or target.job_type <> 'review_transcript'
     or target.input_json ->> 'phase' <> 'global' then
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

  for patch in select value from jsonb_array_elements(p_patches)
  loop
    patch_id := (patch ->> 'segment_id')::uuid;
    update public.transcript_segments
    set revised_text = patch ->> 'revised_text',
        confidence = (patch ->> 'confidence')::numeric,
        review_status = 'auto_reviewed'::public.review_status
    where id = patch_id and class_id = target.class_id
      and transcript_version = review_version;
    if not found then return jsonb_build_object('error_code', 'global_review_segment_mismatch'); end if;
    applied_count := applied_count + 1;
  end loop;

  insert into public.usage_records (
    class_id, processing_job_id, provider, model_name, operation_type,
    input_units, output_units, estimated_cost, request_id, duration_ms
  ) values (
    target.class_id, target.id, 'cloudflare', left(p_model_name, 200), 'review_global',
    p_input_units, p_output_units, 0, left(p_request_id, 200), p_duration_ms
  );

  update public.transcript_versions set status = 'validated', segment_count = total_count
  where class_id = target.class_id and version = review_version;

  select id into summary_job_id from public.processing_jobs
  where idempotency_key = 'generate_summary:' || target.class_id::text ||
    ':t' || review_version::text || ':auto';
  if summary_job_id is null then
    insert into public.materials (
      class_id, user_id, material_type, status, version,
      source_transcript_version, prompt_version, model_name
    ) values (
      target.class_id, target.user_id, 'summary', 'pending',
      coalesce((select max(version) + 1 from public.materials
                where class_id = target.class_id and material_type = 'summary'), 1),
      review_version, 'summary-v1', 'configured-by-worker'
    ) returning id into summary_material_id;

    insert into public.processing_jobs (
      class_id, user_id, job_type, status, stage, priority, max_attempts,
      idempotency_key, input_json
    ) values (
      target.class_id, target.user_id, 'generate_summary', 'pending', 'queued',
      target.priority, 12,
      'generate_summary:' || target.class_id::text || ':t' || review_version::text || ':auto',
      jsonb_build_object('material_id', summary_material_id, 'transcript_version', review_version)
    ) returning id into summary_job_id;
  end if;

  update public.classes
  set status = 'generating_materials', progress = 95,
      current_stage = 'Transcrição pronta; preparando resumo', error_message = null
  where id = target.class_id;

  return jsonb_build_object(
    'applied', applied_count, 'checked', total_count, 'summary_job_id', summary_job_id
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
  material public.materials%rowtype;
  extra_type public.material_type;
  extra_material_id uuid;
  extra_version integer;
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

  update public.materials
  set status = 'completed', structured_content = p_structured_content,
      markdown_content = p_markdown_content, model_name = left(p_model_name, 200),
      error_message = null
  where id = material.id;

  insert into public.usage_records (
    class_id, processing_job_id, provider, model_name, operation_type,
    input_units, output_units, estimated_cost, request_id, duration_ms
  ) select target.class_id, target.id, 'cloudflare', left(p_model_name, 200),
      target.job_type::text, p_input_units, p_output_units, 0,
      left(p_request_id, 200), p_duration_ms
    where not exists (select 1 from public.usage_records where processing_job_id = target.id);

  update public.classes
  set status = 'completed', progress = 100,
      current_stage = case when material.material_type = 'summary'
                           then 'Pronta para estudar' else 'Material pronto' end,
      study_ready_at = case when material.material_type = 'summary'
                            then coalesce(study_ready_at, now()) else study_ready_at end,
      error_message = null
  where id = target.class_id;

  -- A aula é liberada no resumo. Os demais recursos entram automaticamente em
  -- prioridade inferior, sem atrasar a próxima aula que o usuário quer estudar.
  if material.material_type = 'summary' then
    foreach extra_type in array array[
      'notes'::public.material_type,
      'flashcards'::public.material_type,
      'questions'::public.material_type,
      'mindmap'::public.material_type
    ] loop
      select coalesce(max(version), 0) + 1 into extra_version
      from public.materials
      where class_id = target.class_id and material_type = extra_type;

      extra_material_id := null;
      insert into public.materials (
        class_id, user_id, material_type, status, version,
        source_transcript_version, prompt_version, model_name
      ) values (
        target.class_id, target.user_id, extra_type, 'pending', extra_version,
        material.source_transcript_version, 'auto-v1', 'configured-by-worker'
      )
      on conflict (class_id, material_type, version) do nothing
      returning id into extra_material_id;

      if extra_material_id is not null then
        extra_job_type := ('generate_' || extra_type::text)::public.job_type;
        insert into public.processing_jobs (
          class_id, user_id, job_type, status, stage, priority, max_attempts,
          idempotency_key, input_json
        ) values (
          target.class_id, target.user_id, extra_job_type, 'pending', 'queued',
          greatest(target.priority - 20, 0), 12,
          extra_job_type::text || ':' || target.class_id::text || ':t' ||
            material.source_transcript_version::text || ':auto',
          jsonb_build_object(
            'material_id', extra_material_id,
            'transcript_version', material.source_transcript_version,
            'automatic', true
          )
        ) on conflict (idempotency_key) do nothing;
      end if;
    end loop;
  end if;
  return jsonb_build_object('material_id', material.id, 'completed', true);
end;
$$;

revoke all on function public.get_cloud_global_review_input(uuid, text)
  from public, anon, authenticated;
revoke all on function public.apply_cloud_global_review(uuid, text, jsonb, integer, text, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.get_cloud_global_review_input(uuid, text) to service_role;
grant execute on function public.apply_cloud_global_review(uuid, text, jsonb, integer, text, integer, integer, integer, text)
  to service_role;
