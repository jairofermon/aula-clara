-- Algumas falhas de provedor alteravam o status visual da aula para queued,
-- embora o job ativo continuasse sendo review_transcript. A fonte de verdade
-- para a migração é o job, não o status derivado da classe.

create temporary table affected_manual_classes on commit drop as
select distinct class.id, class.transcript_version
from public.classes class
join public.processing_jobs job on job.class_id = class.id
where class.deleted_at is null
  and class.transcript_version > 0
  and job.job_type = 'review_transcript'
  and job.status in ('pending', 'running', 'retry_wait');

update public.processing_jobs job
set status = 'cancelled',
    stage = 'manual_chatgpt_workflow_enabled',
    locked_at = null,
    locked_by = null,
    finished_at = now(),
    error_code = null,
    error_message = null,
    updated_at = now()
from affected_manual_classes affected
where job.class_id = affected.id
  and job.job_type = 'review_transcript'
  and job.status in ('pending', 'running', 'retry_wait');

update public.transcript_versions version
set status = 'assembled'
from affected_manual_classes affected
where version.class_id = affected.id
  and version.version = affected.transcript_version
  and version.status <> 'validated';

update public.classes class
set status = 'needs_user_review',
    progress = 72,
    current_stage = 'Transcrição bruta pronta para o ChatGPT',
    error_message = null,
    updated_at = now()
from affected_manual_classes affected
where class.id = affected.id;
