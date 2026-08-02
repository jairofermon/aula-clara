# AGENTS.md

## Escopo

Estas instruções valem para todo o monorepo Aula Clara.

## Regras

- Preserve TypeScript estrito e schemas Zod/Pydantic nos limites externos.
- Nunca envie `SUPABASE_SERVICE_ROLE_KEY` ou `OPENAI_API_KEY` ao navegador.
- Nunca altere `raw_text` depois de persistido.
- Todo job novo precisa de chave idempotente, política de retry e teste.
- Todo tempo de áudio é inteiro em milissegundos.
- Logs devem usar IDs e métricas, não conteúdo integral de aula.
- Chamadas OpenAI ficam no worker e devem ter fake para testes.
- Execute testes focados após mudanças e a suíte completa antes de entregar.
- Migrations são append-only depois de compartilhadas.

## Comandos

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
python -m pytest services/worker/tests
```
