-- Libera imediatamente jobs deixados em running por uma execução interrompida.
update public.processing_jobs
set status = 'retry_wait',
    stage = 'provider_failover',
    next_attempt_at = now(),
    locked_at = null,
    locked_by = null,
    error_code = 'stale_worker_recovered',
    error_message = 'A execução anterior foi interrompida. O processamento já foi retomado automaticamente.',
    updated_at = now()
where status = 'running'
  and locked_at < now() - interval '2 minutes';

update public.classes c
set status = 'queued',
    current_stage = 'Retomando processamento automaticamente',
    error_message = null,
    updated_at = now()
where exists (
  select 1
  from public.processing_jobs j
  where j.class_id = c.id
    and j.status = 'retry_wait'
    and j.error_code = 'stale_worker_recovered'
);
