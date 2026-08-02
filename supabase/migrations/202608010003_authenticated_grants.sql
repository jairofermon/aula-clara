-- RLS decide quais linhas podem ser acessadas; estes grants habilitam apenas as
-- operações de tabela necessárias ao cliente autenticado.
grant select, insert, update, delete on table
  public.profiles,
  public.subjects,
  public.classes,
  public.class_files,
  public.processing_jobs,
  public.audio_chunks,
  public.transcript_versions,
  public.transcript_segments,
  public.transcript_issues,
  public.materials,
  public.usage_records,
  public.audit_events
to authenticated;

-- A captura e a renovação de locks pertencem exclusivamente ao worker.
revoke all on function public.claim_processing_job(text, integer) from public, anon, authenticated;
revoke all on function public.renew_job_lock(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_processing_job(text, integer) to service_role;
grant execute on function public.renew_job_lock(uuid, text) to service_role;
