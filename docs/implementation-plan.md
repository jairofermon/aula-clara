# Plano de implementação

## Trilha ativa — edição Free Cloud

1. **Concluído:** confirmar Supabase Free em São Paulo, Cloudflare Free e remoto
   GitHub.
2. **Em andamento:** registrar arquitetura, limites e recuperação de entrega.
3. Adicionar build OpenNext, configuração Wrangler e tipos de bindings.
4. Adicionar produtor/consumidor Cloudflare Queue com payload mínimo e claim por ID.
5. Implementar preparo compatível com a primeira cota gratuita e transcrição pelo
   Workers AI.
6. Implementar revisão e materiais com JSON Mode e validação Zod estrita.
7. Mover PDF/CSV para geração no navegador e Storage privado.
8. Aplicar migrations no Supabase hospedado e configurar buckets/RLS/Auth.
9. Publicar no subdomínio `workers.dev` e executar o fluxo E2E.
10. Medir cotas, armazenamento e memória antes de ampliar o tamanho das aulas.

Nenhuma etapa habilita cobrança automática. O provider fake continua sendo usado
nos testes comuns.

## Princípios

- Entregar uma vertical real antes de ampliar o produto.
- Fazer chamadas pagas somente no worker e somente após persistir estado idempotente.
- Manter providers falsos determinísticos para desenvolvimento e testes.
- Validar em cada ciclo com lint, typecheck e testes focados.

## Fases

### 1. Fundação

- Monorepo npm workspaces com `apps/web` e `packages/*`.
- Serviço Python independente em `services/worker`.
- Docker Compose para Supabase CLI/serviços locais documentados, web e worker.
- Configuração estrita de TypeScript, ESLint, Prettier, Vitest, Pytest e Playwright.
- Configuração centralizada e `.env.example` completo.

### 2. Dados e segurança

- Enums, tabelas, constraints, índices e gatilhos de `updated_at`.
- Funções SQL para aquisição/renovação/finalização segura de jobs.
- RLS por proprietário em todas as tabelas.
- Buckets privados e políticas de Storage pelo primeiro componente do path (`auth.uid()`).
- Auditoria mínima, versões de transcrição e exclusão segura preparada.

### 3. Web funcional

- Cadastro, login, logout, recuperação e middleware de sessão.
- Dashboard, disciplinas, criação de aula e upload direto.
- APIs autenticadas para comandos e consultas.
- Página de transcrição com player, busca, filtro, edição debounced e confirmação.
- Materiais: resumo, flashcards/CSV, questões, Mermaid e download assinado.
- Diagnóstico por aula e progresso via polling.

### 4. Worker

- Repositório PostgreSQL com claim por `FOR UPDATE SKIP LOCKED`, lock lease, retries e idempotência.
- Download/upload privado via Supabase Storage.
- FFprobe/FFmpeg, chunks com sobreposição e limite de tamanho.
- Interface de transcrição, OpenAI e fake.
- Consolidação, revisão estruturada, issues e geração estruturada.
- Apostila HTML/PDF com Playwright.

### 5. Qualidade e entrega

- Testes TypeScript de schemas, autenticação, timestamps, transformações e CSV.
- Testes Python de chunks, sobreposição, fila, backoff, validação e retomada.
- E2E controlado com Supabase/worker fake.
- Áudio pequeno gerado localmente para o fluxo de exemplo.
- README e documentação operacional.
- Rodada final: `lint`, `typecheck`, `test`, `build`.

## Ordem de entrega da vertical

1. Autenticação e migrations.
2. Disciplina/aula/upload/job.
3. Preparação/chunks/transcrição fake e real opcional.
4. Visualização/edição/confirmação.
5. Revisão/issues.
6. Materiais e exportações.
7. Robustez, diagnóstico, testes e documentação.

## Definição de pronto

Um item só é considerado concluído quando tem persistência real, autorização, estado de erro compreensível e teste proporcional ao risco. Integrações externas podem ficar desativadas sem credencial, mas devem ter provider real implementado e fake exercitável.
