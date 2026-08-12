-- O produto gratuito encerra na transcrição. Revisão profunda, materiais e PDF
-- deixam de ser jobs: o PDF é montado diretamente no navegador e o usuário o
-- leva ao ChatGPT com um prompt pronto.

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
      status = 'completed',
      progress = 100,
      current_stage = 'Transcrição pronta para download',
      error_message = null,
      study_ready_at = coalesce(study_ready_at, now()),
      updated_at = now()
  where id = target.class_id;
  return jsonb_build_object(
    'version', target_version,
    'segments', segment_count,
    'next_job_id', null,
    'raw_transcript_ready', true,
    'transcript_only_workflow', true,
    'resumed', was_resumed
  );
end;
$$;

revoke all on function public.assemble_cloud_transcript(uuid, text) from public, anon, authenticated;
grant execute on function public.assemble_cloud_transcript(uuid, text) to service_role;

-- Libera aulas antigas que já possuem uma versão consolidada, mas ficaram
-- presas em revisão, materiais ou PDF.
with ready_classes as (
  select class.id
  from public.classes class
  where class.deleted_at is null
    and class.transcript_version > 0
    and exists (
      select 1
      from public.transcript_versions version
      where version.class_id = class.id
        and version.version = class.transcript_version
    )
), cancelled as (
  update public.processing_jobs job
  set status = 'cancelled',
      stage = 'superseded_by_transcript_only_workflow',
      locked_at = null,
      locked_by = null,
      finished_at = now(),
      error_code = null,
      error_message = null,
      updated_at = now()
  from ready_classes ready
  where job.class_id = ready.id
    and job.status in ('pending', 'running', 'retry_wait')
  returning job.class_id
)
update public.classes class
set status = 'completed',
    progress = 100,
    current_stage = 'Transcrição pronta para download',
    error_message = null,
    study_ready_at = coalesce(class.study_ready_at, now()),
    updated_at = now()
from ready_classes ready
where class.id = ready.id;
