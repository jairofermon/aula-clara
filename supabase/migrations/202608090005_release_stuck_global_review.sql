-- Libera revisões globais deixadas em execução por uma versão anterior do
-- worker. A nova versão usa um identificador único por entrega, portanto uma
-- execução antiga não pode concluir ou falhar o lock assumido pela nova.
update public.processing_jobs
set status = 'retry_wait',
    stage = 'retry_wait',
    next_attempt_at = now(),
    locked_at = null,
    locked_by = null,
    error_code = null,
    error_message = null,
    updated_at = now()
where job_type = 'review_transcript'
  and input_json ->> 'phase' = 'global'
  and status in ('running', 'retry_wait');

update public.classes as c
set status = 'queued',
    current_stage = 'Retomando revisão final',
    error_message = null,
    updated_at = now()
where exists (
  select 1
  from public.processing_jobs as j
  where j.class_id = c.id
    and j.job_type = 'review_transcript'
    and j.input_json ->> 'phase' = 'global'
    and j.status = 'retry_wait'
);
