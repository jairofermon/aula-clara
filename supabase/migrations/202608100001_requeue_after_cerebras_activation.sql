-- Reabre somente gerações textuais que ficaram aguardando antes da ativação
-- do Cerebras. Materiais concluídos e transcrições permanecem intocados.
with reopened as (
  update public.processing_jobs
  set status = 'pending',
      stage = 'queued',
      progress = 0,
      attempt_count = 0,
      max_attempts = greatest(max_attempts, 12),
      locked_at = null,
      locked_by = null,
      started_at = null,
      finished_at = null,
      next_attempt_at = now(),
      error_code = null,
      error_message = null,
      updated_at = now()
  where status = 'retry_wait'
    and job_type in (
      'generate_notes',
      'generate_summary',
      'generate_flashcards',
      'generate_questions',
      'generate_mindmap'
    )
    and coalesce(error_code, '') not like '%cerebras_%'
  returning class_id, input_json ->> 'material_id' as material_id
), reset_materials as (
  update public.materials m
  set status = 'pending',
      error_message = null,
      model_name = 'provider-ranking',
      updated_at = now()
  from reopened r
  where r.material_id is not null
    and m.id = r.material_id::uuid
    and m.status <> 'completed'
  returning m.class_id
)
update public.classes c
set status = 'generating_materials',
    current_stage = 'Retomando materiais com o ranking atualizado',
    error_message = null,
    updated_at = now()
where c.id in (select class_id from reopened);
