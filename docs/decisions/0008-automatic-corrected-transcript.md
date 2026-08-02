# ADR 0008 — Transcrição corrigida sem conferência obrigatória

## Status

Aceita em 2026-08-02.

## Contexto

O Whisper gratuito pode produzir mais de mil segmentos de poucos segundos em uma aula longa. Exibir cada microsegmento com estado de revisão e exigir confirmações contradiz o objetivo do produto: entregar um resultado pronto para consulta e estudo.

## Decisão

- preservar integralmente os segmentos originais na versão 1;
- para transcrições com mais de 200 segmentos, criar uma versão operacional agrupando 12 segmentos consecutivos;
- corrigir toda a versão operacional automaticamente e armazenar o resultado em `revised_text`;
- não criar pendências nem bloquear materiais por incerteza do modelo;
- manter timestamps clicáveis para conferência opcional no áudio;
- manter edição manual como recurso opcional, não como etapa do fluxo;
- gerar o PDF diretamente da transcrição corrigida.

## Consequências

A experiência passa a exigir somente upload, espera do processamento e um clique para os materiais. O texto bruto continua auditável. Como qualquer transcrição automática pode conter erro, a interface comunica essa limitação de forma discreta e conserva a navegação por timestamp.
