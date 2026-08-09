update public.classes c
set status = 'queued'::public.class_status,
    current_stage = 'Retomando com capacidade gratuita ampliada',
    error_message = null
where c.id in (
  select j.class_id
  from public.processing_jobs j
  where j.status = 'retry_wait'::public.job_status
    and j.error_code = 'cloudflare_daily_quota'
);

update public.processing_jobs
set status = 'pending'::public.job_status,
    stage = 'queued',
    attempt_count = 0,
    max_attempts = greatest(max_attempts, 12),
    next_attempt_at = now(),
    locked_at = null,
    locked_by = null,
    finished_at = null,
    error_code = null,
    error_message = null
where status = 'retry_wait'::public.job_status
  and error_code = 'cloudflare_daily_quota';
