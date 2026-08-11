-- Cancela materiais automáticos derivados de revisões antigas. O áudio, os
-- arquivos-fonte e raw_text permanecem intactos; apenas saídas derivadas são removidas.

create temporary table affected_legacy_material_classes on commit drop as
select distinct class.id, class.transcript_version
from public.classes class
join public.processing_jobs job on job.class_id = class.id
where class.deleted_at is null
  and class.transcript_version > 0
  and job.job_type in (
    'generate_notes', 'generate_summary', 'generate_flashcards',
    'generate_questions', 'generate_mindmap'
  )
  and job.status in ('pending', 'running', 'retry_wait')
  and not exists (
    select 1 from public.usage_records usage
    where usage.class_id = class.id and usage.provider = 'chatgpt-manual'
  );

update public.processing_jobs job
set status = 'cancelled',
    stage = 'manual_chatgpt_workflow_enabled',
    locked_at = null,
    locked_by = null,
    finished_at = now(),
    error_code = null,
    error_message = null,
    updated_at = now()
from affected_legacy_material_classes affected
where job.class_id = affected.id
  and job.status in ('pending', 'running', 'retry_wait')
  and job.job_type in (
    'review_transcript', 'generate_notes', 'generate_summary',
    'generate_flashcards', 'generate_questions', 'generate_mindmap'
  );

delete from public.materials material
using affected_legacy_material_classes affected
where material.class_id = affected.id;

update public.transcript_versions version
set status = 'assembled'
from affected_legacy_material_classes affected
where version.class_id = affected.id
  and version.version = affected.transcript_version;

update public.classes class
set status = 'needs_user_review',
    progress = 72,
    current_stage = 'Transcrição bruta pronta para o ChatGPT',
    error_message = null,
    study_ready_at = null,
    updated_at = now()
from affected_legacy_material_classes affected
where class.id = affected.id;
