# ADR 0003: Polling para progresso

- Status: aceita
- Data: 2026-08-01

## Decisão

Usar polling autenticado com intervalo controlado e pausa quando a página está oculta.

## Motivo

É previsível em ambiente local, reduz configuração e cobre o volume esperado do MVP. O contrato da API permite migrar para Realtime depois.

## Consequências

Há atraso de poucos segundos e leituras adicionais; respostas usam payload compacto e índices por aula/status.
