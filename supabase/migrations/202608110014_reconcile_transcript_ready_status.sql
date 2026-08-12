-- Some older classes already have persisted transcript segments but were left
-- with a retry/review stage by legacy jobs. Make the persisted transcript the
-- source of truth for the simplified workflow.
insert into public.transcript_versions (
  class_id,
  user_id,
  version,
  status,
  segment_count
)
select
  class.id,
  class.user_id,
  class.transcript_version,
  'assembled',
  count(segment.id)::integer
from public.classes class
join public.transcript_segments segment
  on segment.class_id = class.id
 and segment.transcript_version = class.transcript_version
where class.deleted_at is null
  and class.transcript_version > 0
group by class.id, class.user_id, class.transcript_version
on conflict (class_id, version) do update
set segment_count = excluded.segment_count;

with ready_classes as (
  select class.id
  from public.classes class
  where class.deleted_at is null
    and class.transcript_version > 0
    and exists (
      select 1
      from public.transcript_segments segment
      where segment.class_id = class.id
        and segment.transcript_version = class.transcript_version
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
