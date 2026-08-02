create extension if not exists pgcrypto;

create type public.class_status as enum (
  'uploaded', 'queued', 'preparing_audio', 'transcribing', 'reviewing',
  'needs_user_review', 'generating_materials', 'completed', 'failed'
);
create type public.file_type as enum ('audio', 'slides', 'supplement', 'export');
create type public.job_type as enum (
  'prepare_audio', 'transcribe_chunk', 'assemble_transcript', 'review_transcript',
  'generate_notes', 'generate_summary', 'generate_flashcards',
  'generate_questions', 'generate_mindmap', 'generate_pdf'
);
create type public.job_status as enum ('pending', 'running', 'retry_wait', 'completed', 'failed', 'cancelled');
create type public.chunk_status as enum ('pending', 'ready', 'transcribing', 'completed', 'failed');
create type public.review_status as enum ('unreviewed', 'auto_reviewed', 'needs_review', 'user_confirmed', 'user_edited');
create type public.issue_status as enum ('open', 'resolved', 'dismissed');
create type public.material_type as enum ('notes', 'summary', 'flashcards', 'questions', 'mindmap', 'pdf');
create type public.material_status as enum ('pending', 'generating', 'completed', 'failed');

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  title text not null check (char_length(title) between 2 and 180),
  topic text not null default '' check (char_length(topic) <= 300),
  teacher_name text,
  class_date date not null,
  language text not null default 'pt' check (char_length(language) between 2 and 12),
  speaker_count integer check (speaker_count between 1 and 20),
  notes text not null default '' check (char_length(notes) <= 5000),
  glossary text not null default '' check (char_length(glossary) <= 5000),
  status public.class_status not null default 'uploaded',
  progress smallint not null default 0 check (progress between 0 and 100),
  current_stage text,
  error_message text,
  transcript_version integer not null default 0 check (transcript_version >= 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subject_same_owner foreign key (subject_id, user_id)
    references public.subjects(id, user_id) on delete restrict,
  unique (id, user_id)
);

create table public.class_files (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  file_type public.file_type not null,
  original_name text not null check (char_length(original_name) between 1 and 255),
  storage_path text not null unique,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null check (sha256 ~ '^[a-fA-F0-9]{64}$'),
  duration_ms bigint check (duration_ms >= 0),
  upload_completed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (class_id, sha256, file_type),
  constraint class_file_same_owner foreign key (class_id, user_id)
    references public.classes(id, user_id) on delete cascade
);

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  job_type public.job_type not null,
  status public.job_status not null default 'pending',
  stage text not null default 'pending',
  progress smallint not null default 0 check (progress between 0 and 100),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 4 check (max_attempts between 1 and 20),
  locked_at timestamptz,
  locked_by text,
  started_at timestamptz,
  finished_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  idempotency_key text not null unique,
  input_json jsonb not null default '{}'::jsonb,
  output_json jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_class_same_owner foreign key (class_id, user_id)
    references public.classes(id, user_id) on delete cascade
);

create table public.audio_chunks (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  source_file_id uuid not null references public.class_files(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  start_ms bigint not null check (start_ms >= 0),
  end_ms bigint not null check (end_ms > start_ms),
  storage_path text not null unique,
  sha256 text not null check (sha256 ~ '^[a-fA-F0-9]{64}$'),
  size_bytes bigint not null check (size_bytes > 0),
  status public.chunk_status not null default 'pending',
  transcription_job_id uuid references public.processing_jobs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_file_id, chunk_index)
);

create table public.transcript_versions (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null check (version > 0),
  status text not null check (status in ('assembled', 'reviewed', 'validated')),
  segment_count integer not null default 0 check (segment_count >= 0),
  created_at timestamptz not null default now(),
  unique (class_id, version),
  constraint transcript_version_same_owner foreign key (class_id, user_id)
    references public.classes(id, user_id) on delete cascade
);

create table public.transcript_segments (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  chunk_id uuid references public.audio_chunks(id) on delete set null,
  transcript_version integer not null default 1 check (transcript_version > 0),
  sequence_number integer not null check (sequence_number >= 0),
  start_ms bigint not null check (start_ms >= 0),
  end_ms bigint not null check (end_ms > start_ms),
  speaker_label text,
  raw_text text not null check (char_length(raw_text) > 0),
  revised_text text,
  confidence numeric(5,4) check (confidence between 0 and 1),
  review_status public.review_status not null default 'unreviewed',
  user_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_id, transcript_version, sequence_number)
);

create table public.transcript_issues (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  transcript_segment_id uuid not null references public.transcript_segments(id) on delete cascade,
  issue_type text not null,
  description text not null,
  proposed_text text,
  confidence numeric(5,4) check (confidence between 0 and 1),
  status public.issue_status not null default 'open',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.materials (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  material_type public.material_type not null,
  status public.material_status not null default 'pending',
  version integer not null default 1 check (version > 0),
  source_transcript_version integer not null check (source_transcript_version > 0),
  structured_content jsonb not null default '{}'::jsonb,
  markdown_content text,
  storage_path text,
  prompt_version text not null,
  model_name text not null,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_id, material_type, version),
  constraint material_same_owner foreign key (class_id, user_id)
    references public.classes(id, user_id) on delete cascade
);

create table public.usage_records (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  processing_job_id uuid references public.processing_jobs(id) on delete set null,
  provider text not null,
  model_name text not null,
  operation_type text not null,
  input_units bigint check (input_units >= 0),
  output_units bigint check (output_units >= 0),
  audio_seconds numeric(12,3) check (audio_seconds >= 0),
  estimated_cost numeric(14,6) check (estimated_cost >= 0),
  request_id text,
  duration_ms bigint check (duration_ms >= 0),
  created_at timestamptz not null default now()
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  class_id uuid references public.classes(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index classes_user_created_idx on public.classes(user_id, created_at desc) where deleted_at is null;
create index jobs_claim_idx on public.processing_jobs(status, next_attempt_at, created_at);
create index jobs_class_idx on public.processing_jobs(class_id, created_at desc);
create index chunks_class_idx on public.audio_chunks(class_id, chunk_index);
create index segments_class_sequence_idx on public.transcript_segments(class_id, transcript_version, sequence_number);
create index issues_class_status_idx on public.transcript_issues(class_id, status);
create index materials_class_type_idx on public.materials(class_id, material_type, version desc);

create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger subjects_updated_at before update on public.subjects for each row execute function public.set_updated_at();
create trigger classes_updated_at before update on public.classes for each row execute function public.set_updated_at();
create trigger jobs_updated_at before update on public.processing_jobs for each row execute function public.set_updated_at();
create trigger chunks_updated_at before update on public.audio_chunks for each row execute function public.set_updated_at();
create trigger segments_updated_at before update on public.transcript_segments for each row execute function public.set_updated_at();
create trigger materials_updated_at before update on public.materials for each row execute function public.set_updated_at();

create or replace function public.protect_raw_text()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.raw_text is distinct from new.raw_text then
    raise exception 'raw_text is immutable';
  end if;
  return new;
end;
$$;
create trigger transcript_raw_text_immutable before update on public.transcript_segments
for each row execute function public.protect_raw_text();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.claim_processing_job(p_worker_id text, p_lock_ttl_seconds integer default 300)
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
    where j.attempt_count < j.max_attempts
      and j.next_attempt_at <= now()
      and (
        j.status in ('pending', 'retry_wait')
        or (j.status = 'running' and j.locked_at < now() - make_interval(secs => p_lock_ttl_seconds))
      )
    order by j.next_attempt_at, j.created_at
    for update skip locked
    limit 1
  )
  update public.processing_jobs j
  set status = 'running', locked_by = p_worker_id, locked_at = now(),
      started_at = coalesce(j.started_at, now()), attempt_count = j.attempt_count + 1,
      error_code = null, error_message = null
  from candidate
  where j.id = candidate.id
  returning j.*;
end;
$$;

create or replace function public.renew_job_lock(p_job_id uuid, p_worker_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare affected integer;
begin
  update public.processing_jobs set locked_at = now()
  where id = p_job_id and status = 'running' and locked_by = p_worker_id;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke all on function public.claim_processing_job(text, integer) from public, anon, authenticated;
revoke all on function public.renew_job_lock(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_processing_job(text, integer) to service_role;
grant execute on function public.renew_job_lock(uuid, text) to service_role;
