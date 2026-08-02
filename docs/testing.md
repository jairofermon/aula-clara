# Testes

## Gates padrão

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` executa Vitest em todos os workspaces e Pytest sem integrações externas. Nenhuma API paga é chamada.

## TypeScript

Cobertura focada:

- schemas Zod de aula, upload, revisão e questões;
- exatamente cinco alternativas e uma correta;
- timestamp em milissegundos;
- CSV Anki separado por ponto e vírgula e com escaping;
- filtro de ownership;
- seek do player (`start_ms / 1000`).

Executar somente unitários TS:

```powershell
pnpm test:unit
```

## Python

Cobertura focada:

- plano de chunks, bordas por silêncio e sobreposição;
- timestamp local para global e remoção conservadora de duplicata;
- SQL de claim com `SKIP LOCKED`;
- idempotência, backoff e retomada;
- schema inválido sem persistência parcial;
- revisão fake e falha transitória;
- integrações FFmpeg/OpenAI marcadas e opt-in.

```powershell
python -m pytest services/worker/tests
python -m pytest services/worker/tests -m "not integration"
```

## E2E

O E2E cria seu próprio usuário e áudio WAV, e percorre:

1. cadastro;
2. disciplina e aula;
3. upload direto privado;
4. processamento pelo FFmpeg/worker fake;
5. transcrição e clique em timestamp;
6. edição e confirmação;
7. resumo, apostila, flashcards/CSV, questões e mapa Mermaid;
8. PDF real e download assinado com assinatura `%PDF`.

Pré-condições:

```powershell
pnpm exec supabase start
pnpm dev
docker compose up --build worker
```

Execução usando Chrome instalado:

```powershell
$env:RUN_E2E='1'
$env:PLAYWRIGHT_CHANNEL='chrome'
pnpm test:e2e
```

Sem Chrome do sistema, execute `pnpm exec playwright install chromium` e omita `PLAYWRIGHT_CHANNEL`.

## OpenAI opt-in

`RUN_OPENAI_INTEGRATION=1` e uma chave válida habilitam o teste com amostra pequena. Esse teste é excluído do gate padrão e pode gerar custo.

## Migrations

Use uma base local descartável:

```powershell
pnpm exec supabase db reset --local
```

Esse comando deve aplicar as quatro migrations e `supabase/seed.sql` sem erro.

## Resultado de referência da entrega

- Vitest: 3 arquivos, 6 testes aprovados.
- Pytest: 12 aprovados, 2 integrações opt-in ignoradas.
- Playwright E2E: 1 aprovado, incluindo todos os materiais e PDF.
- Next.js: build de produção aprovado com 15 páginas/handlers coletados.

Os números podem crescer; o critério é saída zero dos quatro gates.
