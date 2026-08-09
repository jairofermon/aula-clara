create or replace function public.fail_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_public_message text,
  p_transient boolean,
  p_retry_delay_seconds integer default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.processing_jobs%rowtype;
  automatic_retry boolean;
  will_retry boolean;
  retry_seconds integer;
  next_status public.job_status;
begin
  select * into target from public.processing_jobs where id = p_job_id for update;
  if target.id is null or target.status <> 'running' or target.locked_by <> p_worker_id then
    return 'ignored';
  end if;

  automatic_retry := p_transient or p_error_code in (
    'all_text_providers_failed', 'all_transcription_providers_failed',
    'invalid_provider_json', 'invalid_provider_schema', 'invalid_review_response',
    'review_segment_ids_mismatch', 'global_review_coverage_mismatch',
    'material_quality_insufficient', 'material_source_mismatch',
    'material_timestamp_mismatch', 'transcription_quality_insufficient',
    'groq_invalid_request'
  ) or (
    target.job_type in (
      'transcribe_chunk', 'review_transcript', 'generate_notes', 'generate_summary',
      'generate_flashcards', 'generate_questions', 'generate_mindmap'
    ) and p_error_code not in ('no_speech', 'audio_too_large', 'invalid_audio', 'empty_audio')
  );
  will_retry := automatic_retry or (p_transient and target.attempt_count < target.max_attempts);
  next_status := case when will_retry then 'retry_wait'::public.job_status else 'failed'::public.job_status end;
  retry_seconds := least(greatest(coalesce(p_retry_delay_seconds, 15), 15), 60);

  update public.processing_jobs
  set status = next_status,
      stage = case when will_retry then 'provider_failover' else 'failed' end,
      attempt_count = case when automatic_retry and target.attempt_count >= target.max_attempts then 0 else attempt_count end,
      error_code = left(p_error_code, 120),
      error_message = left(p_public_message, 500),
      next_attempt_at = case when will_retry then now() + make_interval(secs => retry_seconds) else next_attempt_at end,
      finished_at = case when will_retry then null else now() end,
      locked_at = null,
      locked_by = null
  where id = p_job_id;

  update public.classes
  set status = case when will_retry then 'queued'::public.class_status else 'failed'::public.class_status end,
      current_stage = case when will_retry then 'Alternando provedores automaticamente' else 'Etapa com falha' end,
      error_message = left(p_public_message, 500)
  where id = target.class_id;

  if not will_retry and target.input_json ? 'material_id' then
    update public.materials set status = 'failed', error_message = left(p_public_message, 500)
    where id = (target.input_json ->> 'material_id')::uuid and class_id = target.class_id;
  end if;
  return next_status::text;
end;
$$;

revoke all on function public.fail_processing_job(uuid, text, text, text, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.fail_processing_job(uuid, text, text, text, boolean, integer)
  to service_role;
