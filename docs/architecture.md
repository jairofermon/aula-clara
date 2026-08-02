# Arquitetura do Aula Clara

## Objetivo

A primeira vertical do Aula Clara transforma áudio de aula e materiais opcionais em uma transcrição revisável e em materiais de estudo. O desenho privilegia execução local, persistência, retomada e segurança por proprietário, sem introduzir infraestrutura que o MVP não precisa.

## Componentes

```text
Navegador
  ├─ autenticação Supabase e upload direto para Storage privado
  └─ HTTPS → Next.js App Router
                 ├─ Server Components: leitura autenticada
                 ├─ Route Handlers: comandos, URLs assinadas e validação
                 └─ polling: progresso real dos jobs

Supabase local
  ├─ Auth
  ├─ PostgreSQL + RLS
  └─ Storage (class-audio, class-materials, generated-exports)

Worker Python/FastAPI
  ├─ fila PostgreSQL (FOR UPDATE SKIP LOCKED)
  ├─ FFmpeg/ffprobe
  ├─ OpenAITranscriptionProvider ou FakeTranscriptionProvider
  ├─ revisão e geração estruturadas
  └─ HTML + Playwright → PDF → Storage
```

## Fronteiras de confiança

- O navegador recebe apenas a chave pública/anon do Supabase e uma URL assinada de upload ou download com validade curta.
- O Next.js valida sessão, propriedade e payload em todos os comandos; RLS permanece como segunda barreira.
- A chave `SUPABASE_SERVICE_ROLE_KEY` só existe no servidor web e no worker. Seu uso exige filtro explícito por `user_id` ou `class_id`.
- A chave da OpenAI existe somente no worker.
- Arquivos e exportações ficam em buckets privados; paths começam pelo UUID do proprietário.
- Logs contêm IDs, métricas e códigos de erro, nunca áudio, tokens, transcrições completas ou prompts com conteúdo integral.

## Fluxo principal

1. O usuário se autentica e cria disciplina/aula.
2. O web cria um registro `class_files` pendente e uma URL assinada para o caminho aleatório.
3. O navegador calcula SHA-256 em streaming pelo `File`/Web Crypto, envia diretamente ao Storage e conclui o upload pela API.
4. A conclusão confirma metadados, bloqueia duplicata por aula/hash e cria `prepare_audio` por chave idempotente.
5. O worker toma o job, baixa o áudio para diretório temporário, valida com ffprobe e gera blocos mono a 16 kHz, com alvo e sobreposição configuráveis.
6. Cada chunk persistido cria um job `transcribe_chunk`. O provider retorna segmentos locais, convertidos para milissegundos globais.
7. `assemble_transcript` ordena e remove somente duplicações sustentadas pela janela de sobreposição.
8. `review_transcript` escreve apenas `revised_text`, issues e status, preservando `raw_text`.
9. Materiais são jobs independentes e versionados. Cada um usa o texto efetivo validado (`revised_text`/confirmado; nunca substitui o bruto).
10. `generate_pdf` renderiza HTML controlado para PDF e armazena o resultado no bucket privado.

## Estratégia de retomada

- Toda etapa tem `idempotency_key` única.
- O resultado pago é persistido antes de encadear o próximo job.
- Um chunk com segmentos persistidos e status concluído não volta ao fornecedor.
- Locks expirados podem ser retomados; tentativas usam backoff exponencial com jitter determinístico limitado.
- Falhas permanentes encerram o job e exibem mensagem segura. Falhas transitórias atualizam `next_attempt_at`.
- Ações de retry só reabrem a etapa falha; dependências concluídas são reutilizadas.

## Progresso

O MVP usa polling a cada 2–4 segundos. O progresso é derivado de fatos persistidos:

- preparação: marcos validados do ffprobe/chunking;
- transcrição: chunks concluídos / chunks totais;
- revisão e materiais: lotes ou artefatos concluídos / total;
- PDF: conteúdo, renderização e upload.

Não há percentuais baseados apenas em tempo decorrido.

## Stack e versões registradas

As versões exatas ficam nos manifests/lockfiles. Linha-base consultada e escolhida em 2026-08-01: Node.js 22 LTS, Next.js 16.2.12 (Active LTS), React 19.2.8, TypeScript 6.0.3, Tailwind CSS 4.3.3, Vitest 4.1.10 e Playwright 1.62.1; Python 3.12, FastAPI 0.128/Pydantic 2.12, psycopg 3.3, OpenAI Python 2.20 e pytest 9. O TypeScript 7.0.2 foi avaliado, mas o `typescript-eslint` 8.65 ainda o rejeita explicitamente; a linha 6.x é a versão estável compatível. O lockfile é a fonte reproduzível.

## Limites deliberados

- Um processo worker é suficiente no desenvolvimento; o protocolo aceita concorrência.
- Polling é preferido a Realtime na primeira vertical.
- Extração de PDF é texto contextual limitado, não OCR.
- Diarização é preservada quando o provider a retorna; falantes nunca são inferidos.
- Exclusão física de dados e política automática de retenção ficam preparadas, mas não automatizadas no MVP.
