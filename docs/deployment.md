# Deploy web gratuito

## Topologia escolhida

```text
GitHub
  ↓ build/deploy manual
Cloudflare Workers + OpenNext
  ├─ aplicação Next.js
  ├─ Queue: entrega somente job_id
  ├─ cron: recupera jobs persistidos sem entrega
  └─ Workers AI: transcrição, revisão e materiais
          ↓
Supabase Free (São Paulo)
  ├─ Auth
  ├─ PostgreSQL + RLS + processing_jobs
  └─ Storage privado
```

O PostgreSQL é a fonte de verdade da fila. A Cloudflare Queue apenas entrega o ID; perder ou duplicar uma mensagem não perde nem duplica uma etapa paga, porque claim, locks, tentativas e resultados são persistidos e idempotentes. Um cron de cinco minutos recoloca jobs elegíveis na Queue.

O PDF é gerado com `pdf-lib` no navegador autenticado a partir da apostila já validada e enviado diretamente ao bucket privado. Isso evita executar Chromium em um servidor pago.

Consulte [ADR 0007](decisions/0007-free-cloud-deployment.md) antes de mudar a topologia.

## O que “gratuito” significa

- ChatGPT Plus não fornece uma chave nem créditos da OpenAI API.
- O caminho publicado usa Workers AI e não possui fallback para OpenAI.
- Nenhum recurso pago é criado por este repositório.
- Ao atingir cota, o job fica em retry e a interface informa a indisponibilidade; a execução recomeça após a renovação.
- As cotas são do provedor e podem mudar. Verifique-as no painel antes de uso intenso.

O limite próprio do Aula Clara começa em 15 MB por áudio, abaixo do limite por arquivo do Supabase Free. Essa primeira implantação em nuvem trata o áudio como um único chunk e não executa FFmpeg.

## Pré-requisitos

- repositório GitHub `jairofermon/aula-clara`;
- projeto Supabase `rctuenfnwlzmmpyjzhmq`, região São Paulo;
- conta Cloudflare gratuita com Workers AI e Queues disponíveis;
- Node.js 22 e pnpm 10.15.1 no computador usado apenas para publicar.

Depois do deploy, o produto roda na web e o computador pode ser desligado.

## Passo 1 — Supabase

Autentique a CLI e aplique as migrations:

```powershell
pnpm exec supabase login
pnpm exec supabase link --project-ref rctuenfnwlzmmpyjzhmq
pnpm exec supabase db push
```

Confirme no painel:

1. **Database → Tables** contém `subjects`, `classes`, `class_files`, `processing_jobs`, `audio_chunks`, `transcript_segments`, `transcript_issues`, `materials` e `usage_records`.
2. **Storage** contém os buckets privados `class-audio`, `class-materials` e `generated-exports`.
3. RLS está habilitado nas tabelas de usuário.
4. Em **Project Settings → API**, copie a URL, a chave publicável/anon e a service role.

A service role ignora RLS: nunca a cole no chat, navegador, `.env.production.local` ou GitHub. Ela entra apenas pelo prompt de segredo do Wrangler.

## Passo 2 — Cloudflare

Faça login:

```powershell
pnpm --filter @aula-clara/web exec wrangler login
```

Crie as duas filas gratuitas uma única vez:

```powershell
pnpm --filter @aula-clara/web exec wrangler queues create aula-clara-processing
pnpm --filter @aula-clara/web exec wrangler queues create aula-clara-processing-dlq
```

Crie `apps/web/.secrets.production`, ignorado pelo Git, contendo:

```text
SUPABASE_SERVICE_ROLE_KEY=<service-role-do-painel-supabase>
```

Esse arquivo é usado por `wrangler deploy --secrets-file`, que envia código e segredo na mesma versão. Isso evita publicar temporariamente um Worker sem todos os segredos. O arquivo nunca deve ser commitado ou compartilhado; apague-o após o deploy se preferir.

- `SUPABASE_URL` já está em `wrangler.jsonc`, pois é pública;
- `SUPABASE_SERVICE_ROLE_KEY` é o único segredo obrigatório do Worker;
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` é publicável e entra em `.env.production.local` para ser incorporada ao build.

Os nomes das filas, binding `AI`, cron, limites e modelos ficam versionados em `apps/web/wrangler.jsonc`.

## Passo 3 — variáveis públicas de build

Crie `apps/web/.env.production.local`:

```text
NEXT_PUBLIC_APP_URL=https://aula-clara.<subdominio>.workers.dev
NEXT_PUBLIC_SUPABASE_URL=https://rctuenfnwlzmmpyjzhmq.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<chave-publicável>
PROCESSING_DISPATCH_MODE=cloudflare
MAX_AUDIO_UPLOAD_SIZE_MB=15
MAX_MATERIAL_UPLOAD_SIZE_MB=50
SIGNED_URL_TTL_SECONDS=300
```

O arquivo é ignorado pelo Git. A chave anon é publicável, mas continua sujeita a RLS; a service role não é variável pública.

Para suportar até quatro aulas de 80 minutos por dia sem consumir a cota de áudio do Workers AI, crie uma chave no plano gratuito da Groq e grave-a como segredo do Worker:

```powershell
pnpm --filter @aula-clara/web exec wrangler secret put GROQ_API_KEY
```

A chave fica somente no Cloudflare. A fila respeita o limite gratuito de duas horas de áudio por janela horária e retoma automaticamente respostas `429`; o teto diário publicado pela Groq é de oito horas de áudio.

Para habilitar o segundo transcritor do ranking, crie uma chave do AssemblyAI e grave-a sem colocá-la em arquivo:

```bash
cd apps/web
pnpm exec wrangler secret put ASSEMBLYAI_API_KEY
```

O ID assíncrono retornado pelo AssemblyAI é persistido no job antes da espera. Uma interrupção retoma o mesmo pedido, sem reenviar o áudio ou criar outra transcrição.

Para habilitar a reserva seguinte de áudio, grave a chave do Deepgram:

```bash
cd apps/web
pnpm exec wrangler secret put DEEPGRAM_API_KEY
```

O Deepgram usa Nova-3 com português, formatação inteligente, timestamps por trecho e diarização atual.

Para habilitar a última reserva de revisão e materiais, grave a chave do OpenRouter e aceite conscientemente o roteamento de texto no `wrangler.jsonc`:

```bash
cd apps/web
pnpm exec wrangler secret put OPENROUTER_API_KEY
```

O modelo `openrouter/free` mantém custo de inferência em zero; indisponibilidade ou limite diário gera retry/fallback, nunca troca automática para um modelo pago.

Reservas opcionais, sempre sem cobrança automática:

```powershell
pnpm --filter @aula-clara/web exec wrangler secret put GEMINI_API_KEY
pnpm --filter @aula-clara/web exec wrangler secret put OPENROUTER_API_KEY
```

Depois de revisar os termos de tratamento de dados, altere no `wrangler.jsonc` somente os consentimentos desejados para `accepted` e publique novamente. A presença da chave isoladamente nunca envia conteúdo a esses provedores.

## Passo 4 — validar e publicar

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @aula-clara/web build:cloudflare
pnpm --filter @aula-clara/web deploy:cloudflare
```

O último comando mostra o domínio `workers.dev`. Se o subdomínio real for diferente do valor de `NEXT_PUBLIC_APP_URL`, corrija a variável e publique novamente.

## Passo 5 — autenticação

No Supabase, abra **Authentication → URL Configuration**:

- Site URL: URL exata do Worker;
- Redirect URLs:
  - `https://aula-clara.<subdominio>.workers.dev/auth/callback`
  - `https://aula-clara.<subdominio>.workers.dev/reset-password`

Durante o primeiro smoke test, mantenha confirmação de e-mail conforme sua preferência. O fluxo de recuperação já está preparado; a entrega de e-mail em produção depende das cotas/configuração de Auth do Supabase.

## Passo 6 — smoke test real

1. Cadastre um usuário e entre.
2. Crie uma disciplina.
3. Crie uma aula com WAV/MP3 pequeno, com fala clara e menos de 15 MB.
4. Confirme progresso de `queued` até transcrição/revisão.
5. Abra a transcrição e clique em um timestamp.
6. Edite ou confirme os trechos pendentes.
7. Gere resumo, flashcards, questões, mapa mental e apostila.
8. Gere o PDF e baixe pela URL assinada.
9. Abra **Diagnóstico** e confirme jobs, tentativas e uso sem conteúdo integral nos logs.

## Passo 7 — domínio próprio opcional

O domínio `workers.dev` é suficiente e gratuito. Como a conta Cloudflare já está ativa, um domínio existente pode ser ligado depois em **Workers & Pages → Custom Domains**. Ao mudar o domínio:

1. atualize `NEXT_PUBLIC_APP_URL`;
2. atualize Site URL e redirects no Supabase;
3. refaça o build/deploy;
4. teste login e recuperação de senha.

## GitHub

O workflow `.github/workflows/ci.yml` já executa lint, typecheck, testes, build Next e build OpenNext em Linux. Ele não publica e não usa credenciais reais.

O deploy inicial permanece manual para evitar configuração prematura. Quando estiver estável, adicione um job de deploy protegido com:

- `CLOUDFLARE_API_TOKEN` limitado ao Worker/Queues;
- `CLOUDFLARE_ACCOUNT_ID`;
- variáveis públicas de build;
- gates antes do deploy.

Não armazene service role no GitHub se ela já está no secret store do Worker. O workflow também não deve criar planos pagos.

## Operação e retomada

- `processing_jobs` controla estado, lock, tentativa, backoff e idempotência.
- Queue usa lote de um job e reentrega em falha temporária.
- O cron procura jobs pendentes, retries vencidos e locks expirados.
- Transcrição persistida não chama novamente o Workers AI.
- Revisão e materiais são gravados somente após validação integral do schema.
- Falhas permanentes exibem mensagem segura; detalhes técnicos ficam em logs por `class_id`, `job_id` e `chunk_id`.

## Limitações e expansão futura

A publicação gratuita inicial não oferece conversão FFmpeg, chunking de arquivos longos, diarização confiável, OCR, antivírus, purge LGPD automático, SLA ou compliance para dados médicos. Para áudio longo, a próxima evolução é processamento em chunks num runtime apropriado; isso só deve ser adotado após medir custo e limites, sem habilitar cobrança automaticamente.

O worker Python permanece como implementação de referência para FFmpeg, OpenAI opcional e PDF Playwright, mas não é necessário para operar o caminho web gratuito.
