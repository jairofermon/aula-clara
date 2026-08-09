update public.processing_jobs
set status = 'pending',
    stage = 'queued',
    attempt_count = 0,
    max_attempts = greatest(max_attempts, 12),
    next_attempt_at = now(),
    locked_at = null,
    locked_by = null,
    finished_at = null,
    error_code = null,
    error_message = null
where job_type = 'review_transcript'
  and status in ('retry_wait', 'failed')
  and error_code in (
    'invalid_provider_json',
    'invalid_provider_schema',
    'review_segment_ids_mismatch'
  );

update public.classes c
set status = 'queued',
    current_stage = 'Correção automática retomada',
    error_message = null
where exists (
  select 1
  from public.processing_jobs j
  where j.class_id = c.id
    and j.job_type = 'review_transcript'
    and j.status = 'pending'
    and j.stage = 'queued'
);
