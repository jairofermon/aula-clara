# Aula Clara

Vertical funcional web para transformar uma aula gravada em transcrição corrigida automaticamente, apostila, resumo, flashcards, questões, mapa mental e PDF.

O caminho principal de publicação não exige servidor local nem OpenAI API paga:

```text
Navegador → Cloudflare Workers/OpenNext → Supabase Auth/PostgreSQL/Storage
                              ↓
                   Cloudflare Queue + Workers AI
                              ↓
           transcrição, revisão e materiais persistidos
```

A assinatura ChatGPT Plus ajuda a desenvolver o projeto, mas não inclui créditos da OpenAI API. Por isso, a implantação gratuita usa Workers AI; `OPENAI_API_KEY` permanece opcional e exclusiva do worker Python local.

## O que já funciona

- cadastro, login, logout, recuperação de senha e rotas privadas;
- disciplinas, aulas e uploads privados por URL assinada;
- hash SHA-256, validação de MIME/extensão/tamanho e deduplicação;
- fila persistida no PostgreSQL, entrega por Cloudflare Queue e recuperação por cron;
- transcrição com timestamps numéricos, compactação de microsegmentos e correção automática;
- player sincronizado, busca e edição opcional com proteção contra perda;
- apostila, resumo, flashcards/CSV, questões e mapa mental;
- pacote completo em um clique e PDF da transcrição gerado no navegador;
- URLs de download de curta duração, diagnóstico, auditoria e logs sem conteúdo integral;
- provider falso determinístico para testes e worker Python/FFmpeg como caminho local opcional.

Detalhes: [arquitetura](docs/architecture.md), [pipeline](docs/processing-pipeline.md), [modelo de dados](docs/data-model.md), [deploy gratuito](docs/deployment.md) e [segurança](docs/privacy-and-security.md).

## Versões escolhidas

- Node.js 22+, pnpm 10.15.1, Next.js 16.2.12, React 19.2.8;
- TypeScript 6.0.3 estrito, Tailwind CSS 4.3.3, ESLint 9.39.2 e Prettier 3.9.6;
- OpenNext Cloudflare 1.20.2, Wrangler 4.118.0 e pdf-lib 1.17.1;
- Vitest 4.1.10 e Playwright 1.62.1;
- Python 3.12, FastAPI 0.128.0, Pydantic 2.12.5, psycopg 3.3.2, OpenAI 2.20.0 e pytest 9.0.2;
- Supabase CLI 2.111.0 e PostgreSQL 17 no ambiente local de validação.

As versões transitivas estão travadas em `pnpm-lock.yaml` e `services/worker/pyproject.toml`.

## Publicar sem custo

Você precisa de contas gratuitas no GitHub, Supabase e Cloudflare. Não cole chaves secretas no chat nem faça commit delas.

### 1. Instalar o projeto

```powershell
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile
```

### 2. Vincular e migrar o Supabase

O projeto informado usa o ref `rctuenfnwlzmmpyjzhmq` na região São Paulo.

```powershell
pnpm exec supabase login
pnpm exec supabase link --project-ref rctuenfnwlzmmpyjzhmq
pnpm exec supabase db push
```

No painel do Supabase, copie a URL do projeto e a chave pública/anon. A service role é segredo e será cadastrada apenas no Cloudflare.

### 3. Configurar o Cloudflare

```powershell
pnpm --filter @aula-clara/web exec wrangler login
pnpm --filter @aula-clara/web exec wrangler queues create aula-clara-processing
pnpm --filter @aula-clara/web exec wrangler queues create aula-clara-processing-dlq
```

Crie `apps/web/.secrets.production`, arquivo ignorado pelo Git, com somente:

```text
SUPABASE_SERVICE_ROLE_KEY=<service-role-do-painel-supabase>
```

Não envie esse arquivo a ninguém. O deploy o transmite criptografado junto com a primeira versão do Worker; `SUPABASE_URL` já está versionada por ser pública e a chave anon fica no build público.

### 4. Informar as variáveis públicas de build

Crie `apps/web/.env.production.local` — arquivo ignorado pelo Git:

```text
NEXT_PUBLIC_APP_URL=https://aula-clara.<sua-conta>.workers.dev
NEXT_PUBLIC_SUPABASE_URL=https://rctuenfnwlzmmpyjzhmq.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<chave pública do Supabase>
PROCESSING_DISPATCH_MODE=cloudflare
MAX_AUDIO_UPLOAD_SIZE_MB=15
MAX_MATERIAL_UPLOAD_SIZE_MB=50
SIGNED_URL_TTL_SECONDS=300
```

### 5. Fazer build e publicar

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @aula-clara/web build:cloudflare
pnpm --filter @aula-clara/web deploy:cloudflare
```

Depois do deploy, apague `apps/web/.secrets.production` do computador se não quiser mantê-lo localmente; o segredo continuará criptografado no Cloudflare.

### 6. Fechar a autenticação

No Supabase, em **Authentication → URL Configuration**, defina o endereço publicado como Site URL e adicione:

```text
https://aula-clara.<sua-conta>.workers.dev/auth/callback
https://aula-clara.<sua-conta>.workers.dev/reset-password
```

O roteiro completo, incluindo teste real e solução de erros, está em [docs/deployment.md](docs/deployment.md).

## Limites deliberados da publicação gratuita

- áudio limitado a 15 MB para manter uma única chamada de transcrição no Worker gratuito;
- slides e materiais complementares limitados a 50 MB por arquivo, o teto do Supabase Free;
- sem diarização: falante fica nulo quando o modelo não o identifica;
- sem FFmpeg no Cloudflare nesta etapa; vídeos/áudios que exijam conversão devem ser convertidos antes do envio;
- PDF é produzido no navegador, sem Chromium pago no servidor;
- cotas gratuitas podem pausar o processamento até a renovação; não existe fallback automático para serviço pago;
- o Supabase gratuito pode pausar projeto inativo e possui limites de banco/Storage.

O caminho Python local continua disponível para chunks com FFmpeg, provider OpenAI opcional e PDF por Playwright. Consulte [desenvolvimento local](docs/local-development.md) somente se quiser usá-lo.

## Qualidade

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Cloudflare:

```powershell
pnpm --filter @aula-clara/web build:cloudflare
```

E2E completo com infraestrutura controlada:

```powershell
$env:RUN_E2E='1'
$env:PLAYWRIGHT_CHANNEL='chrome'
pnpm test:e2e
```

Nenhum teste comum chama API paga. Veja [docs/testing.md](docs/testing.md).

## Variáveis principais

| Variável                        | Onde               | Uso                                             |
| ------------------------------- | ------------------ | ----------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`           | build web          | URL pública e callbacks.                        |
| `NEXT_PUBLIC_SUPABASE_URL`      | build web          | URL pública da API Supabase.                    |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | build/runtime web  | Chave publicável protegida por RLS.             |
| `SUPABASE_URL`                  | segredo Cloudflare | API usada pelo consumidor.                      |
| `SUPABASE_SERVICE_ROLE_KEY`     | segredo Cloudflare | Acesso exclusivo do consumidor às RPCs/Storage. |
| `PROCESSING_DISPATCH_MODE`      | web                | `cloudflare` na publicação; `postgres` local.   |
| `CLOUDFLARE_*_MODEL`            | Worker             | Modelos centralizados do Workers AI.            |
| `MAX_AUDIO_UPLOAD_SIZE_MB`      | web/Worker         | Limite funcional de áudio gratuito: 15 MB.      |
| `MAX_MATERIAL_UPLOAD_SIZE_MB`   | web/Worker         | Limite do Supabase Free: 50 MB por material.    |
| `SIGNED_URL_TTL_SECONDS`        | web                | Validade dos downloads privados.                |
| `OPENAI_API_KEY`                | Python opcional    | Nunca necessária no caminho gratuito.           |

A lista completa e comentada está em [.env.example](.env.example).

## Documentação

- [Arquitetura](docs/architecture.md)
- [Plano](docs/implementation-plan.md)
- [Modelo de dados](docs/data-model.md)
- [Pipeline](docs/processing-pipeline.md)
- [Privacidade e segurança](docs/privacy-and-security.md)
- [API](docs/api.md)
- [Prompts](docs/prompts.md)
- [Testes](docs/testing.md)
- [Deploy](docs/deployment.md)

## Fora do MVP

Cobrança, equipes, compartilhamento, OCR, app móvel, edição colaborativa, antivírus, painel administrativo e garantia de retenção/compliance médico. A exclusão de disciplina é bloqueada quando existem aulas, evitando perda acidental.
