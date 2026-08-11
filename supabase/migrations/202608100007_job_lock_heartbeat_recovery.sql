-- Um crash na última tentativa não pode deixar o job eternamente em
-- `running`. Jobs com lock ausente também são órfãos e precisam ser retomados.
create index if not exists jobs_stale_lock_idx
  on public.processing_jobs(locked_at)
  where status = 'running';

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
  where
    (
      (
        j.status in ('pending', 'retry_wait')
        and j.attempt_count < j.max_attempts
        and j.next_attempt_at <= now()
      )
      or (
        j.status = 'running'
        and (
          j.locked_at is null
          or j.locked_at < now() - make_interval(secs => greatest(p_lock_ttl_seconds, 30))
        )
      )
    )
    -- A listagem e o claim precisam aplicar a mesma regra de prioridade. Sem
    -- isso, um job órfão de baixa prioridade seria listado a cada minuto,
    -- recusado pelo claim e impediria o agendador de alcançar o job prioritário.
    and not exists (
      select 1
      from public.processing_jobs higher
      where higher.user_id = j.user_id
        and higher.priority > j.priority
        and higher.attempt_count < higher.max_attempts
        and higher.next_attempt_at <= now()
        and higher.status in ('pending', 'retry_wait')
    )
  order by
    case when j.status = 'running' then 0 else 1 end,
    j.priority desc,
    j.next_attempt_at asc,
    j.created_at asc
  limit least(greatest(p_limit, 1), 100);
$$;

create or replace function public.claim_processing_job_by_id(
  p_job_id uuid,
  p_worker_id text,
  p_lock_ttl_seconds integer default 120
)
returns setof public.processing_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select j.id
    from public.processing_jobs j
    where j.id = p_job_id
      and (
        (
          j.status in ('pending', 'retry_wait')
          and j.attempt_count < j.max_attempts
          and j.next_attempt_at <= now()
        )
        or (
          j.status = 'running'
          and (
            j.locked_at is null
            or j.locked_at < now() - make_interval(secs => greatest(p_lock_ttl_seconds, 30))
          )
        )
      )
      and not exists (
        select 1
        from public.processing_jobs higher
        where higher.user_id = j.user_id
          and higher.priority > j.priority
          and higher.attempt_count < higher.max_attempts
          and higher.next_attempt_at <= now()
          and higher.status in ('pending', 'retry_wait')
      )
    for update skip locked
  )
  update public.processing_jobs j
  set status = 'running',
      locked_by = p_worker_id,
      locked_at = now(),
      started_at = coalesce(j.started_at, now()),
      attempt_count = case
        when j.status = 'running' and j.attempt_count >= j.max_attempts then 1
        else j.attempt_count + 1
      end,
      error_code = null,
      error_message = null
  from candidate
  where j.id = candidate.id
  returning j.*;
end;
$$;

revoke all on function public.get_ready_processing_job_ids(integer, integer)
  from public, anon, authenticated;
revoke all on function public.claim_processing_job_by_id(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.get_ready_processing_job_ids(integer, integer)
  to service_role;
grant execute on function public.claim_processing_job_by_id(uuid, text, integer)
  to service_role;

-- Corrige imediatamente jobs órfãos que ficaram na última tentativa.
update public.processing_jobs
set status = 'retry_wait',
    stage = 'automatic_recovery',
    attempt_count = least(attempt_count, greatest(max_attempts - 1, 0)),
    next_attempt_at = now(),
    locked_at = null,
    locked_by = null,
    error_code = 'stale_worker_recovered',
    error_message = 'A execução anterior foi interrompida. O processamento foi retomado automaticamente.',
    updated_at = now()
where status = 'running'
  and (
    locked_at is null
    or locked_at < now() - interval '2 minutes'
  );

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
