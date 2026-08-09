-- Respostas malformadas devem trocar de provedor na mesma execução e, se todos
-- falharem, voltar rapidamente à fila. Esta migração também libera trabalhos
-- que tenham sido agendados com o backoff antigo de até cinco minutos.
update public.processing_jobs
set next_attempt_at = now(),
    stage = 'retry_wait',
    updated_at = now()
where status = 'retry_wait'
  and error_code in ('invalid_provider_json', 'invalid_provider_schema');

update public.classes as c
set status = 'queued',
    current_stage = 'Retomando com outro provedor',
    error_message = null,
    updated_at = now()
where exists (
  select 1
  from public.processing_jobs as j
  where j.class_id = c.id
    and j.status = 'retry_wait'
    and j.error_code in ('invalid_provider_json', 'invalid_provider_schema')
);
