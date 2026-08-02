create or replace function public.continue_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_output jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.processing_jobs
  set status = 'pending',
      stage = 'continuing',
      output_json = coalesce(output_json, '{}'::jsonb) || coalesce(p_output, '{}'::jsonb),
      next_attempt_at = now(),
      locked_at = null,
      locked_by = null,
      attempt_count = greatest(attempt_count - 1, 0)
  where id = p_job_id
    and status = 'running'
    and locked_by = p_worker_id;

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke all on function public.continue_processing_job(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.continue_processing_job(uuid, text, jsonb)
  to service_role;
