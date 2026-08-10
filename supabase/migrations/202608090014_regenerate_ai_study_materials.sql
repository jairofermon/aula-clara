-- Remove materiais extrativos de contingência e reabra seus jobs para geração real por IA.
with bad_materials as (
  select id
  from public.materials
  where material_type in ('notes', 'summary', 'flashcards', 'questions', 'mindmap')
    and model_name like 'extractive-%'
), reset_materials as (
  update public.materials m
  set status = 'pending',
      structured_content = '{}'::jsonb,
      markdown_content = null,
      storage_path = null,
      error_message = null,
      model_name = 'provider-ranking',
      prompt_version = case m.material_type
        when 'notes' then 'notes-v4'
        when 'summary' then 'summary-v4'
        when 'flashcards' then 'flashcards-v4'
        when 'questions' then 'questions-v5'
        when 'mindmap' then 'mindmap-v5'
        else m.prompt_version
      end,
      updated_at = now()
  from bad_materials b
  where m.id = b.id
  returning m.id, m.class_id
), reset_jobs as (
  update public.processing_jobs j
  set status = 'pending',
      stage = 'queued',
      progress = 0,
      attempt_count = 0,
      max_attempts = greatest(j.max_attempts, 12),
      locked_at = null,
      locked_by = null,
      started_at = null,
      finished_at = null,
      next_attempt_at = now(),
      output_json = '{}'::jsonb,
      error_code = null,
      error_message = null,
      updated_at = now()
  from reset_materials m
  where j.input_json ->> 'material_id' = m.id::text
  returning j.class_id
)
update public.classes c
set status = 'generating_materials',
    current_stage = 'Gerando materiais de estudo com IA',
    error_message = null,
    updated_at = now()
where c.id in (select class_id from reset_jobs);
