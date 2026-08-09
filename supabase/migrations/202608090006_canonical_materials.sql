-- Um material canônico por aula e tipo. Tentativas de provedores são detalhes
-- internos do job e nunca criam v2/v3 visíveis para o usuário.
with ranked as (
  select id,
    first_value(id) over (
      partition by class_id, material_type
      order by (version = 1) desc, version asc, created_at asc
    ) as keeper_id,
    first_value(id) over (
      partition by class_id, material_type
      order by (status = 'completed') desc, version desc, updated_at desc
    ) as best_id
  from public.materials
), choices as (
  select distinct keeper_id, best_id from ranked
)
update public.materials keeper
set status = best.status,
    source_transcript_version = best.source_transcript_version,
    structured_content = best.structured_content,
    markdown_content = best.markdown_content,
    storage_path = best.storage_path,
    prompt_version = best.prompt_version,
    model_name = best.model_name,
    error_message = best.error_message,
    updated_at = greatest(keeper.updated_at, best.updated_at)
from choices choice
join public.materials best on best.id = choice.best_id
where keeper.id = choice.keeper_id;

with ranked as (
  select id,
    row_number() over (
      partition by class_id, material_type
      order by (version = 1) desc, version asc, created_at asc
    ) as position
  from public.materials
), duplicates as (
  select id from ranked where position > 1
)
update public.processing_jobs job
set status = 'failed', stage = 'superseded', progress = 100,
    error_code = 'superseded_material_version',
    error_message = 'Substituído pelo material único da aula.',
    finished_at = now(), locked_at = null, locked_by = null
where job.status in ('pending', 'running', 'retry_wait')
  and exists (
    select 1 from duplicates duplicate
    where job.input_json ->> 'material_id' = duplicate.id::text
  );

with ranked as (
  select id,
    row_number() over (
      partition by class_id, material_type
      order by (version = 1) desc, version asc, created_at asc
    ) as position
  from public.materials
)
delete from public.materials material
using ranked
where material.id = ranked.id and ranked.position > 1;

update public.materials set version = 1 where version <> 1;

create unique index if not exists materials_one_per_class_type_idx
  on public.materials (class_id, material_type);

create or replace function public.prevent_duplicate_material()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.version := 1;
  if exists (
    select 1 from public.materials existing
    where existing.class_id = new.class_id
      and existing.material_type = new.material_type
  ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists materials_prevent_duplicate_automatic on public.materials;
drop trigger if exists materials_prevent_duplicate on public.materials;
create trigger materials_prevent_duplicate
before insert on public.materials
for each row execute function public.prevent_duplicate_material();

-- Recupera somente materiais canônicos vazios que ficaram sem job.
update public.materials material
set status = 'pending', error_message = null, updated_at = now()
where material.status = 'generating'
  and material.material_type <> 'pdf'
  and not exists (
    select 1 from public.processing_jobs job
    where job.input_json ->> 'material_id' = material.id::text
      and job.status in ('pending', 'running', 'retry_wait')
  );

insert into public.processing_jobs (
  class_id, user_id, job_type, status, stage, priority, max_attempts,
  idempotency_key, input_json
)
select material.class_id, material.user_id,
  ('generate_' || material.material_type::text)::public.job_type,
  'pending', 'queued', greatest(class.processing_priority - 20, 0), 12,
  'canonical-material:' || material.id::text,
  jsonb_build_object(
    'material_id', material.id,
    'transcript_version', material.source_transcript_version,
    'canonical', true,
    'recovered', true
  )
from public.materials material
join public.classes class on class.id = material.class_id
where material.status = 'pending'
  and material.material_type <> 'pdf'
  and not exists (
    select 1 from public.processing_jobs job
    where job.input_json ->> 'material_id' = material.id::text
      and job.status in ('pending', 'running', 'retry_wait')
  )
on conflict (idempotency_key) do nothing;
