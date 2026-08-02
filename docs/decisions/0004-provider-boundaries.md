# ADR 0004: Providers substituíveis e respostas estruturadas

- Status: aceita
- Data: 2026-08-01

## Decisão

Isolar transcrição e geração atrás de interfaces. OpenAI é a implementação real; providers falsos determinísticos são usados em testes e no modo de demonstração explícito.

## Motivo

Permite testar toda a vertical sem custo, impede acoplamento do pipeline a um endpoint e concentra modelos/credenciais na configuração do worker.

## Consequências

Todo resultado externo passa por schema estrito e normalização antes de entrar no domínio.
