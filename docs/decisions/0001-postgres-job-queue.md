# ADR 0001: Fila persistida no PostgreSQL

- Status: aceita
- Data: 2026-08-01

## Decisão

Usar `processing_jobs` e aquisição por função SQL com `FOR UPDATE SKIP LOCKED`, lease renovável e idempotency key única.

## Motivo

O PostgreSQL já é dependência obrigatória, oferece durabilidade e concorrência suficiente para o MVP. Redis/Celery aumentariam operação sem resolver uma necessidade atual.

## Consequências

Jobs longos precisam renovar lease; rotinas devem ser curtas fora das chamadas externas; monitoramento ocorre consultando o próprio banco.
