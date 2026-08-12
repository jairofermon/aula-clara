# Arquitetura do Aula Clara

## Alvo de produção gratuito

A primeira implantação pública usa uma arquitetura híbrida Supabase + Cloudflare,
sem OpenAI API obrigatória:

```text
Navegador → Next.js/OpenNext em Cloudflare Workers
   ├─ sessão e dados → Supabase Auth/PostgreSQL com RLS
   ├─ áudio TUS retomável → Supabase Storage privado
   ├─ PDFs assinados → Supabase Storage privado
   └─ comandos → processing_jobs → Cloudflare Queue
                                      └─ consumidor TypeScript
                                         ├─ Workers AI Whisper
                                         ├─ Workers AI JSON Mode
                                         └─ Supabase REST/RPC
```

`processing_jobs` continua sendo a fonte persistente. A Queue contém somente
`job_id`, permite entrega duplicada e não substitui os locks, tentativas ou chaves
de idempotência do PostgreSQL. Um varredor periódico recupera jobs que tenham sido
persistidos, mas não entregues.

O worker Python descrito abaixo permanece como implementação local e provider
opcional. A decisão completa está em
[ADR 0007](decisions/0007-free-cloud-deployment.md).

## Objetivo

A primeira vertical do Aula Clara transforma áudio de aula em uma transcrição integral com timestamps e PDF. O usuário leva o PDF ao ChatGPT com um prompt pronto para revisão e materiais de estudo. O desenho privilegia persistência, retomada e segurança por proprietário.

## Componentes

```text
Navegador
  ├─ autenticação Supabase
  ├─ áudio TUS e materiais para Supabase Storage privado
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
  └─ pdf-lib no navegador → download local
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
8. A versão original permanece imutável; aulas com muitos microsegmentos ganham uma versão compacta e `review_transcript` escreve a correção final em `revised_text`.
9. Materiais são jobs independentes e versionados. Cada um usa o texto efetivo validado (`revised_text`/confirmado; nunca substitui o bruto).
10. Na web gratuita, o navegador monta e baixa o PDF diretamente, sem criar `generate_pdf`.

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
- transcrição: chunks persistidos / total;
- PDF: geração local iniciada explicitamente pelo usuário, fora da fila.

Não há percentuais baseados apenas em tempo decorrido.

## Stack e versões registradas

As versões exatas ficam nos manifests/lockfiles. Linha-base consultada e escolhida em 2026-08-01: Node.js 22 LTS, Next.js 16.2.12 (Active LTS), React 19.2.8, TypeScript 6.0.3, Tailwind CSS 4.3.3, Vitest 4.1.10 e Playwright 1.62.1; Python 3.12, FastAPI 0.128/Pydantic 2.12, psycopg 3.3, OpenAI Python 2.20 e pytest 9. O TypeScript 7.0.2 foi avaliado, mas o `typescript-eslint` 8.65 ainda o rejeita explicitamente; a linha 6.x é a versão estável compatível. O lockfile é a fonte reproduzível.

## Limites deliberados

- Um processo worker é suficiente no desenvolvimento; o protocolo aceita concorrência.
- Polling é preferido a Realtime na primeira vertical.
- Extração de PDF é texto contextual limitado, não OCR.
- Diarização é preservada quando o provider a retorna; falantes nunca são inferidos.
- Exclusão física de dados e política automática de retenção ficam preparadas, mas não automatizadas no MVP.
