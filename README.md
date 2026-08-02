# Aula Clara

Vertical funcional de um produto educacional que recebe uma gravação de aula, prepara o áudio com FFmpeg, transcreve em segmentos com tempos numéricos, conduz uma revisão humana conservadora e gera apostila, resumo, flashcards, questões, mapa mental e PDF.

O fluxo principal usa Supabase real local (Auth, PostgreSQL e Storage privado), fila persistida e worker Python. `PROVIDER_MODE=fake` substitui somente as chamadas pagas e é determinístico; FFmpeg, banco, uploads, locks, revisão, materiais e PDF continuam reais.

## Arquitetura em um minuto

```text
Browser → Next.js App Router → Supabase Auth/PostgreSQL (RLS)
   └─ upload direto por URL assinada → Storage privado

PostgreSQL processing_jobs → worker Python
   ├─ FFmpeg/ffprobe → chunks FLAC sobrepostos
   ├─ TranscriptionProvider → segmentos em ms
   ├─ revisão e materiais com schemas Pydantic estritos
   └─ HTML escapado → Playwright/Chromium → PDF privado
```

Detalhes: [arquitetura](docs/architecture.md), [pipeline](docs/processing-pipeline.md), [modelo de dados](docs/data-model.md) e [segurança](docs/privacy-and-security.md).

## Versões escolhidas

- Node.js 22+, pnpm 10.15.1, Next.js 16.2.12, React 19.2.8.
- TypeScript 6.0.3 em modo estrito, Tailwind CSS 4.3.3, ESLint 9.39.2, Prettier 3.9.6.
- Vitest 4.1.10 e Playwright 1.62.1.
- Python 3.12, FastAPI 0.128.0, Pydantic 2.12.5, psycopg 3.3.2, OpenAI 2.20.0 e pytest 9.0.2.
- Supabase CLI 2.111.0; PostgreSQL local 17; FFmpeg 7 no container do worker.

As versões exatas e transitivas estão em `pnpm-lock.yaml` e `services/worker/pyproject.toml`. As decisões de compatibilidade estão em `docs/decisions/`.

## Pré-requisitos

- Node.js 22 ou superior e Corepack.
- Python 3.12.
- Docker Desktop com o daemon ativo.
- Git. FFmpeg e Chromium não precisam estar no host quando o worker roda pelo Compose.

## Instalação e configuração

PowerShell, a partir da raiz:

```powershell
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile

py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e "services/worker[test]"

Copy-Item .env.example .env
pnpm exec supabase start
pnpm exec supabase status -o env
```

Copie do último comando `API_URL` para `NEXT_PUBLIC_SUPABASE_URL`, `ANON_KEY` para `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SERVICE_ROLE_KEY` para `SUPABASE_SERVICE_ROLE_KEY` e `DB_URL` para `SUPABASE_DB_URL` no `.env`. Depois:

```powershell
pnpm configure:web
```

Esse script cria `apps/web/.env.local` somente com variáveis públicas e limites; ele exclui a service role e a chave OpenAI. `.env` e `.env.local` são ignorados pelo Git.

## Migrations e Supabase

`supabase start` aplica as migrations automaticamente. Para comprovar uma instalação limpa ou reaplicar tudo:

```powershell
pnpm exec supabase db reset --local
```

Studio: `http://127.0.0.1:54323`. Mailpit para recuperação de senha: `http://127.0.0.1:54324`.

## Executar localmente

Forma recomendada, com web no host para hot reload e worker com FFmpeg/Chromium no Docker:

```powershell
# terminal 1
pnpm dev

# terminal 2
docker compose up --build worker
```

A aplicação fica em `http://localhost:3000`. O provider falso é o padrão seguro. Para executar web e worker em containers:

```powershell
docker compose up --build web worker
```

Para rodar o worker no host, instale FFmpeg no `PATH`, instale o Chromium do Playwright e execute:

```powershell
.\.venv\Scripts\Activate.ps1
python -m playwright install chromium
aula-clara-worker
```

## Processar o áudio de exemplo

```powershell
pnpm example:audio
```

Depois, cadastre-se, crie uma disciplina, abra **Nova aula** e envie `tests/fixtures/aula-exemplo.wav`. Com `PROVIDER_MODE=fake`, o worker gera dois segmentos, uma pendência de revisão e todos os materiais sem custo externo.

## Usar a OpenAI

Preencha apenas no `.env` do worker:

```text
PROVIDER_MODE=openai
OPENAI_API_KEY=...
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-transcribe-diarize
OPENAI_REVIEW_MODEL=gpt-5.6
OPENAI_GENERATION_MODEL=gpt-5.6
```

Modelos são centralizados por configuração. O provider de transcrição também aceita `whisper-1` e modos não diarizados. Nenhum teste comum chama APIs pagas.

## Qualidade

Os quatro gates pedidos:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

E2E completo, com Supabase, web e worker fake já ativos:

```powershell
$env:RUN_E2E='1'
$env:PLAYWRIGHT_CHANNEL='chrome'
pnpm test:e2e
```

Integração opcional paga:

```powershell
$env:RUN_OPENAI_INTEGRATION='1'
python -m pytest services/worker/tests -m integration
```

Veja [testing](docs/testing.md) para a matriz completa.

## Variáveis de ambiente

| Variável                             | Uso                                              |
| ------------------------------------ | ------------------------------------------------ |
| `NEXT_PUBLIC_APP_URL`                | Origem pública e callbacks de autenticação.      |
| `NEXT_PUBLIC_SUPABASE_URL`           | URL pública da API Supabase.                     |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`      | Chave publicável protegida por RLS.              |
| `SUPABASE_INTERNAL_URL`              | URL opcional usada de dentro dos containers.     |
| `SUPABASE_SERVICE_ROLE_KEY`          | Segredo usado somente pelo worker para Storage.  |
| `SUPABASE_DB_URL`                    | Conexão PostgreSQL direta do worker.             |
| `OPENAI_API_KEY`                     | Segredo do provider OpenAI; vazio no modo fake.  |
| `OPENAI_TRANSCRIPTION_MODEL`         | Modelo de transcrição.                           |
| `OPENAI_REVIEW_MODEL`                | Modelo de revisão estruturada.                   |
| `OPENAI_GENERATION_MODEL`            | Modelo dos materiais.                            |
| `PROVIDER_MODE`                      | `fake` ou `openai`.                              |
| `AUDIO_CHUNK_TARGET_SECONDS`         | Duração-alvo dos chunks; padrão 600.             |
| `AUDIO_CHUNK_OVERLAP_SECONDS`        | Sobreposição; padrão 5.                          |
| `MAX_UPLOAD_SIZE_MB`                 | Limite do upload original.                       |
| `MAX_TRANSCRIPTION_CHUNK_MB`         | Limite interno antes do provider.                |
| `SIGNED_URL_TTL_SECONDS`             | Validade de URLs privadas.                       |
| `WORKER_ID`                          | Identidade registrada nos locks.                 |
| `WORKER_POLL_SECONDS`                | Intervalo de busca por jobs.                     |
| `WORKER_LOCK_TTL_SECONDS`            | Lease do job em segundos.                        |
| `LOG_LEVEL`                          | Nível dos logs JSON.                             |
| `OPENAI_*_COST_*`                    | Tarifas opcionais usadas apenas para estimativa. |
| `RUN_E2E` / `RUN_OPENAI_INTEGRATION` | Habilitam testes opt-in.                         |

## Documentação

- [Desenvolvimento local](docs/local-development.md)
- [API](docs/api.md)
- [Testes](docs/testing.md)
- [Prompts](docs/prompts.md)
- [Deploy](docs/deployment.md)
- [Plano de implementação](docs/implementation-plan.md)

## Limites do MVP

Sem cobrança, times, compartilhamento, OCR, app móvel, edição colaborativa, antivírus, painel administrativo ou automação de retenção. A exclusão de disciplina é bloqueada quando existem aulas; a exclusão lógica da aula está preparada no modelo, mas a UI de ciclo de vida não faz parte desta vertical.
