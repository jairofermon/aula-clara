-- Garante a retomada imediata de gerações que estavam em retry_wait no momento
-- da troca do ranking. O bloco registra quantos jobs foram efetivamente reabertos.
do $$
declare
  reopened_count integer;
begin
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
    );

  get diagnostics reopened_count = row_count;
  raise notice 'Aula Clara: % jobs de materiais reabertos para o ranking Cerebras', reopened_count;
end
$$;

update public.materials m
set status = 'pending',
    error_message = null,
    model_name = 'provider-ranking',
    updated_at = now()
where m.status <> 'completed'
  and exists (
    select 1
    from public.processing_jobs j
    where j.input_json ->> 'material_id' = m.id::text
      and j.status = 'pending'
      and j.job_type in (
        'generate_notes',
        'generate_summary',
        'generate_flashcards',
        'generate_questions',
        'generate_mindmap'
      )
  );

update public.classes c
set status = 'generating_materials',
    current_stage = 'Retomando materiais com o ranking atualizado',
    error_message = null,
    updated_at = now()
where exists (
  select 1
  from public.processing_jobs j
  where j.class_id = c.id
    and j.status = 'pending'
    and j.job_type in (
      'generate_notes',
      'generate_summary',
      'generate_flashcards',
      'generate_questions',
      'generate_mindmap'
    )
);
