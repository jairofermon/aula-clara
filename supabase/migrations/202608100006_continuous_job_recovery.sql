-- Mantém o pipeline contínuo quando uma invocação do Cloudflare termina antes
-- de liberar o lock. O agendador passa a enxergar jobs prontos e locks vencidos.
create or replace function public.get_ready_processing_job_ids(
  p_limit integer default 20,
  p_lock_ttl_seconds integer default 120
)
returns table(id uuid)
language sql
security definer
set search_path = public
as $$
  select j.id
  from public.processing_jobs j
  where j.attempt_count < j.max_attempts
    and (
      (j.status in ('pending', 'retry_wait') and j.next_attempt_at <= now())
      or (
        j.status = 'running'
        and j.locked_at < now() - make_interval(secs => greatest(p_lock_ttl_seconds, 30))
      )
    )
  order by
    case when j.status = 'running' then 0 else 1 end,
    j.priority desc,
    j.next_attempt_at asc,
    j.created_at asc
  limit least(greatest(p_limit, 1), 100);
$$;

revoke all on function public.get_ready_processing_job_ids(integer, integer)
  from public, anon, authenticated;
grant execute on function public.get_ready_processing_job_ids(integer, integer)
  to service_role;

-- Retoma imediatamente os trabalhos órfãos já existentes. Cada etapa é
-- idempotente; os trechos persistidos não serão revisados novamente.
update public.processing_jobs
set status = 'retry_wait',
    stage = 'automatic_recovery',
    next_attempt_at = now(),
    locked_at = null,
    locked_by = null,
    error_code = 'stale_worker_recovered',
    error_message = 'A execução anterior foi interrompida. O processamento foi retomado automaticamente.',
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
