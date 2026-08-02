# ADR 0002: Upload direto para Storage privado

- Status: aceita
- Data: 2026-08-01

## Decisão

O servidor cria um path aleatório e uma URL assinada. O navegador envia o arquivo diretamente ao Supabase Storage e depois confirma hash/metadados pela API.

## Motivo

Evita manter arquivos grandes na memória do Next.js, preserva progresso/cancelamento e mantém autorização centralizada.

## Consequências

A conclusão precisa confirmar a existência do objeto; uploads abandonados exigirão coleta futura; buckets e policies são privados.
