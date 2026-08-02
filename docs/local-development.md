# Desenvolvimento local

## Topologia

O Supabase CLI inicia PostgreSQL, Auth, Storage, Studio e Mailpit em containers. A web pode rodar no host ou em container. O worker é recomendado em container porque a imagem fixa FFmpeg e Chromium.

```text
host:3000        web
host:54321       Supabase API/Storage/Auth
host:54322       PostgreSQL
host:54323       Studio
host:54324       Mailpit
worker container → host.docker.internal:54321/54322
```

## Primeiro uso no Windows

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

Preencha o `.env` com os valores locais e execute `pnpm configure:web`. Para macOS/Linux, use `python3.12 -m venv .venv`, `source .venv/bin/activate` e `cp .env.example .env`.

## Ciclo diário

```powershell
pnpm exec supabase start
pnpm dev
```

Em outro terminal:

```powershell
docker compose up --build worker
```

Logs:

```powershell
docker compose logs -f worker
pnpm exec supabase status
```

Parar serviços:

```powershell
docker compose stop worker
pnpm exec supabase stop
```

## Banco e migrations

Crie uma migration com `pnpm exec supabase migration new nome`. Nunca edite uma migration que já chegou a um ambiente compartilhado; crie outra. Validação local limpa:

```powershell
pnpm exec supabase db reset --local
```

Migrations atuais:

1. `202608010001_initial_schema.sql`: enums, tabelas, constraints, triggers, índices e fila.
2. `202608010002_rls_storage.sql`: RLS, policies e buckets privados.
3. `202608010003_authenticated_grants.sql`: grants de tabela e bloqueio das funções internas.
4. `202608010004_allow_worker_audio_format.sql`: MIME FLAC interno.

## Providers

`PROVIDER_MODE=fake` é determinístico e não chama rede paga. `PROVIDER_MODE=openai` exige chave e modelos. Nunca coloque `OPENAI_API_KEY` em `apps/web/.env.local`.

## FFmpeg

A imagem do worker executa ffprobe e FFmpeg 7. No host, `ffmpeg` e `ffprobe` precisam existir no `PATH`. O worker converte a entrada para FLAC mono/16 kHz; áudio gerado pelo Playwright interno não substitui esse estágio.

## Diagnóstico

- `FFmpeg ausente`: use o worker Docker ou instale FFmpeg.
- `permission denied for table`: aplique todas as migrations, especialmente a 003.
- upload interno FLAC com 400: aplique a migration 004.
- web em container sem Supabase: mantenha `SUPABASE_INTERNAL_URL=http://host.docker.internal:54321`.
- job parado em `running`: aguarde o TTL; outro worker recuperará o lease expirado.
- recuperação de senha: abra Mailpit e siga o link local.
- retorno OpenAI inválido: o batch não é salvo parcialmente; consulte o diagnóstico da aula.
