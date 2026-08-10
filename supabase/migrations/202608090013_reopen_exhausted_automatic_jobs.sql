-- Jobs de IA em retry_wait são contínuos; o contador serve para observabilidade,
-- mas não pode impedir o claim depois de uma recuperação de worker interrompido.
update public.processing_jobs
set attempt_count = 0,
    next_attempt_at = now(),
    locked_at = null,
    locked_by = null,
    updated_at = now()
where status = 'retry_wait'
  and attempt_count >= max_attempts
  and job_type in (
    'transcribe_chunk',
    'review_transcript',
    'generate_notes',
    'generate_summary',
    'generate_flashcards',
    'generate_questions',
    'generate_mindmap'
  );
