# ADR 0007 — Produção gratuita em Supabase e Cloudflare

## Status

Aceita em 2026-08-02.

## Contexto

O MVP original executa corretamente com Supabase local, worker Python, FFmpeg,
Playwright e providers OpenAI/fake. A primeira publicação precisa funcionar na web
sem mensalidade adicional e sem depender da OpenAI API, porque uma assinatura
ChatGPT Plus não inclui uso da API.

O plano gratuito do Supabase oferece Auth, PostgreSQL e Storage privado, mas limita
cada arquivo a 50 MB e o armazenamento total a 1 GB. O plano gratuito do
Cloudflare oferece Workers, Queues e uma cota diária de Workers AI. Workers comuns
têm CPU muito restrita, mas consumidores de Queue podem ter até 5 minutos de CPU e
15 minutos de duração por invocação.

## Decisão

1. Hospedar o Next.js com OpenNext em Cloudflare Workers.
2. Manter Supabase Free como sistema de registro para Auth, PostgreSQL, RLS e
   arquivos privados.
3. Manter `processing_jobs` como fila persistente e fonte de verdade.
4. Usar Cloudflare Queues somente como mecanismo de entrega de IDs de jobs. Áudio,
   transcrição e segredos nunca entram nas mensagens.
5. Executar transcrição com `@cf/openai/whisper-large-v3-turbo` no Workers AI.
6. Executar revisão e geração com um modelo do Workers AI que aceite JSON Mode,
   validando toda resposta com Zod antes da persistência.
7. Preservar o worker Python e o provider OpenAI como caminhos opcionais para
   desenvolvimento e futura infraestrutura paga.
8. Na primeira publicação gratuita, processar um arquivo de áudio já compatível
   como um único chunk, com limite conservador. O preparo com FFmpeg no navegador e
   o suporte a aulas maiores serão adicionados em uma etapa posterior.
9. Gerar PDF e CSV no navegador e enviar o resultado ao Storage privado, evitando
   Chromium no servidor.
10. Não cadastrar forma de pagamento nem habilitar cobrança automática durante a
    implantação desta edição.

## Entrega e retomada

O Route Handler persiste o job antes de publicar `{ job_id }` na Queue. O consumidor
faz claim do ID com função SQL transacional e ignora jobs já concluídos. Um Cron
Trigger consulta periodicamente jobs pendentes sem entrega e publica novamente seus
IDs. Duplicatas de entrega são esperadas e seguras por causa da chave de
idempotência e do claim condicional.

Falhas temporárias continuam usando `next_attempt_at`, tentativas e backoff no
PostgreSQL. Falhas permanentes permanecem visíveis na aula. Uma chamada de IA cujo
resultado já foi persistido nunca é repetida.

## Consequências

- A aplicação pode ser publicada sem uma conta OpenAI API.
- Não há identificação de falantes no provider gratuito inicial; o valor será nulo
  ou `unknown`.
- A qualidade e a disponibilidade dependem dos modelos e das cotas gratuitas.
- Ao esgotar a cota diária, jobs aguardam nova tentativa sem gerar cobrança.
- O limite inicial de áudio será menor que o objetivo comercial e será mostrado
  antes do upload.
- O processamento de mídia grande no navegador exige uma decisão separada, testes
  de memória em celular e uma política explícita de retenção.

## Alternativas rejeitadas

- Automatizar o site do ChatGPT: inseguro, frágil e não constitui uma API de
  produto.
- Vercel Hobby como alvo principal: as condições gratuitas são voltadas a uso
  pessoal e não comercial.
- GitHub Actions como worker de produto: latência, limites e finalidade inadequados.
- Cron Worker como processador principal: limite de CPU insuficiente no plano Free.
- Remover o PostgreSQL da fila: perderia retomada, diagnóstico e idempotência já
  implementados.
