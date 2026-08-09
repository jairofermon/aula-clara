# Modelo de dados

## Convenções

- UUIDs gerados no PostgreSQL.
- Datas de sistema em `timestamptz` UTC.
- Posições e durações de áudio em inteiros de milissegundos.
- JSON estruturado em `jsonb`, validado no limite da aplicação.
- Registros do usuário carregam `user_id` mesmo quando derivável, simplificando RLS e auditoria.
- `raw_text` é imutável depois da montagem; correções usam `revised_text`.

## Entidades

### Identidade e organização

- `profiles`: extensão 1:1 de `auth.users`, com `role` (`admin`/`member`),
  `approval_status`, responsável e data da aprovação.
- `subjects`: disciplina pertencente a um usuário.
- `classes`: unidade de processamento; contém estado e progresso agregados.
- `audit_events`: ação, ator, recurso e metadados não sensíveis.

### Arquivos e processamento

- `class_files`: áudio, slides, complemento ou exportação; hash e metadados verificáveis.
- `processing_jobs`: fila persistente, lease, tentativas, idempotência, entrada/saída e erro.
- `audio_chunks`: janela global, path, hash, status e job de transcrição.

### Transcrição e revisão

- `transcript_versions`: versão montada e versão validada atual.
- `transcript_segments`: segmento ordenado, tempos globais, falante opcional, bruto e revisado.
- `transcript_issues`: incerteza categorizada ligada ao segmento.

### Materiais e custos

- `materials`: tipo/versionamento, conteúdo JSON/Markdown, path de exportação e proveniência do prompt/modelo.
- `usage_records`: operação, unidades, segundos de áudio, custo estimado e request ID.

## Relações principais

```text
auth.users 1──1 profiles
auth.users 1──N subjects 1──N classes
classes 1──N class_files
classes 1──N processing_jobs
class_files 1──N audio_chunks
audio_chunks 1──N transcript_segments
transcript_segments 1──N transcript_issues
classes 1──N transcript_versions
classes 1──N materials
processing_jobs 1──N usage_records
```

## Constraints essenciais

- `classes.progress`, `processing_jobs.progress` entre 0 e 100.
- `speaker_count > 0` quando informado.
- `size_bytes >= 0`, `duration_ms >= 0`, `start_ms >= 0`, `end_ms > start_ms`.
- `confidence` entre 0 e 1 quando informada.
- `unique(class_id, sha256, file_type)` evita duplicação na mesma aula.
- `unique(class_id, sequence_number)` mantém ordem estável.
- `unique(idempotency_key)` impede jobs duplicados.
- `unique(class_id, material_type, version)` versiona materiais.

## RLS

O predicado principal é `user_id = auth.uid()`. Tabelas sem `user_id` explícito usam `exists` pela classe proprietária. Operações de Storage exigem bucket permitido e primeiro diretório igual a `auth.uid()::text`.

O worker usa service role, que ignora RLS; por isso o repositório do worker sempre carrega e propaga `user_id`, e testes verificam o filtro de escopo.

## Estados

### Aula

`uploaded`, `queued`, `preparing_audio`, `transcribing`, `reviewing`, `needs_user_review`, `generating_materials`, `completed`, `failed`.

### Job

`pending`, `running`, `retry_wait`, `completed`, `failed`, `cancelled`.

### Revisão

`unreviewed`, `auto_reviewed`, `needs_review`, `user_confirmed`, `user_edited`.

## Exclusão e retenção

Disciplinas só são excluídas sem aulas. Aulas usam `deleted_at` para exclusão lógica inicial; um comando administrativo futuro poderá remover arquivos e registros após janela de retenção. Registros de auditoria não guardam conteúdo sensível.
