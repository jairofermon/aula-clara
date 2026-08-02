# ADR 0006: TypeScript 6 enquanto o linter não suporta TypeScript 7

- Status: aceita
- Data: 2026-08-01

## Decisão

Fixar TypeScript 6.0.3, embora 7.0.2 seja a versão mais nova consultada no registry.

## Motivo

O `typescript-eslint` 8.65.0 encerra com erro explícito ao carregar a API do TypeScript 7. Usar uma combinação oficialmente incompatível impediria cumprir o critério de lint e criaria risco de diagnóstico incorreto.

## Consequências

O projeto permanece em modo estrito e com toolchain estável. A atualização para TypeScript 7 será feita quando o `typescript-eslint` declarar suporte.
