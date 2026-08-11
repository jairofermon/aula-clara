-- Versões antigas podiam avançar quando o texto bruto era preservado após a
-- indisponibilidade de todos os provedores. Elas precisam voltar à revisão real.

update public.processing_jobs job
set status = 'cancelled',
    stage = 'invalidated_false_review',
    idempotency_key = job.idempotency_key || ':invalidated:' || left(job.id::text, 8),
    finished_at = now(),
    locked_at = null,
    locked_by = null,
    error_code = 'source_transcript_not_ai_validated',
    error_message = 'O material será recriado após uma revisão real por inteligência artificial.',
    updated_at = now()
where job.job_type in (
    'generate_notes', 'generate_summary', 'generate_flashcards',
    'generate_questions', 'generate_mindmap', 'generate_pdf'
  )
  and exists (
    select 1
    from public.usage_records usage
    join public.classes class on class.id = usage.class_id
    where usage.class_id = job.class_id
      and (
        usage.model_name = 'original-preserved-after-provider-failover'
        or usage.model_name = 'segment-review-validated'
      )
  );

delete from public.materials material
where exists (
  select 1
  from public.usage_records usage
  where usage.class_id = material.class_id
    and (
      usage.model_name = 'original-preserved-after-provider-failover'
      or usage.model_name = 'segment-review-validated'
    )
);

update public.transcript_segments segment
set revised_text = null,
    confidence = null,
    review_status = 'unreviewed',
    user_confirmed = false,
    updated_at = now()
from public.classes class
where class.id = segment.class_id
  and segment.transcript_version = class.transcript_version
  and exists (
    select 1
    from public.usage_records usage
    where usage.class_id = class.id
      and (
        usage.model_name = 'original-preserved-after-provider-failover'
        or usage.model_name = 'segment-review-validated'
      )
  );

update public.transcript_versions version
set status = 'assembled'
from public.classes class
where class.id = version.class_id
  and version.version = class.transcript_version
  and exists (
    select 1
    from public.usage_records usage
    where usage.class_id = class.id
      and (
        usage.model_name = 'original-preserved-after-provider-failover'
        or usage.model_name = 'segment-review-validated'
      )
  );

insert into public.processing_jobs (
  class_id, user_id, job_type, status, stage, priority, max_attempts,
  idempotency_key, input_json
)
select class.id, class.user_id, 'review_transcript', 'pending', 'queued',
  class.processing_priority, 1000000,
  'review_transcript:' || class.id::text || ':v' || class.transcript_version::text || ':real-ai',
  jsonb_build_object(
    'transcript_version', class.transcript_version,
    'phase', 'segments',
    'requires_real_ai', true
  )
from public.classes class
where exists (
  select 1
  from public.usage_records usage
  where usage.class_id = class.id
    and (
      usage.model_name = 'original-preserved-after-provider-failover'
      or usage.model_name = 'segment-review-validated'
    )
)
on conflict (idempotency_key) do update
set status = 'pending',
    stage = 'queued',
    next_attempt_at = now(),
    finished_at = null,
    locked_at = null,
    locked_by = null,
    error_code = null,
    error_message = null,
    max_attempts = greatest(public.processing_jobs.max_attempts, 1000000),
    updated_at = now();

update public.classes class
set status = 'reviewing',
    progress = 72,
    current_stage = 'Refazendo revisão real por inteligência artificial',
    error_message = null,
    study_ready_at = null,
    updated_at = now()
where exists (
  select 1
  from public.usage_records usage
  where usage.class_id = class.id
    and (
      usage.model_name = 'original-preserved-after-provider-failover'
      or usage.model_name = 'segment-review-validated'
    )
);
