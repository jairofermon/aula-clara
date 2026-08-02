# Prompts e respostas estruturadas

## Objetivo

Prompts são tratados como interfaces versionadas. O texto gerado nunca é autoridade sobre IDs, tempos, permissões ou estado da fila; esses valores vêm do banco e passam por schemas Zod no consumidor Cloudflare ou Pydantic no worker Python.

## Versões

| Produto              | Versão          |
| -------------------- | --------------- |
| Correção automática  | `review-v3`     |
| Apostila estruturada | `notes-v1`      |
| Resumo               | `summary-v1`    |
| Flashcards           | `flashcards-v1` |
| Questões             | `questions-v2`  |
| Mapa mental          | `mindmap-v2`    |

As constantes de produto ficam em `packages/prompts/src/index.ts`; `materials.prompt_version` registra a versão usada. O consumidor Workers AI usa JSON Mode com JSON Schema derivado do Zod compartilhado. O provider Python mantém os schemas Pydantic equivalentes. Em ambos os caminhos, validação e persistência são separadas.

## Correção automática

Invariantes:

- preservar IDs, ordem, sentido e exemplos;
- não resumir nem introduzir conhecimento externo;
- corrigir somente pontuação, português evidente e termos com confiança;
- corrigir o texto para uma versão final utilizável, sem resumir;
- em incerteza, preservar a formulação mais fiel em vez de inventar;
- retornar todos os índices curtos do lote uma vez; o servidor os associa aos IDs imutáveis.

O schema valida índice, `revised_text` e confiança. Índices ausentes, extras ou duplicados rejeitam integralmente aquela resposta; nada dela é salvo parcialmente. No caminho Cloudflare, o worker subdivide automaticamente um lote inconsistente e cada nova resposta válida é associada aos IDs reais e aplicada por uma RPC transacional. Todos os trechos seguem como `auto_reviewed`, sem confirmação manual. `raw_text` permanece imutável.

## Contexto

A transcrição pode receber título, disciplina, professor, glossário e texto extraído do PDF. O PDF é lido com `pypdf` em modo estrito, limitado a 40 páginas/10 mil caracteres. O arquivo bruto nunca é enviado como texto.

O modelo diarizado não recebe prompt contextual; o contexto é preservado para motores que o suportam. Sem diarização, `speaker_label` fica nulo; o sistema não inventa falantes.

## Materiais

Cada produto recebe somente a transcrição efetiva da versão validada. A instrução proíbe HTML e exige milissegundos/IDs de origem.

- Resumo: visão geral, conceitos, mecanismos, classificações, causalidade, exemplos, ênfases, pegadinhas, prova e referências.
- Flashcards: frente/verso, timestamp, tags, dificuldade e segmentos-fonte.
- Questões: cinco alternativas distintas, exatamente uma correta e explicações.
- Mapa: hierarquia JSON e Mermaid `mindmap` com labels simples.
- Apostila: seções cronológicas, exemplos, ênfases e dúvidas.

Zod/Pydantic rejeitam forma, cardinalidade, IDs ou timestamps inválidos. Mermaid é renderizado em modo estrito e sanitizado; o modelo não produz o binário PDF.

## Workers AI gratuito

- Transcrição: `@cf/openai/whisper-large-v3-turbo`, idioma `pt`, VAD e contexto limitado.
- Revisão e materiais: `@cf/meta/llama-3.1-8b-instruct-fast` em JSON Mode.
- A configuração está centralizada no `wrangler.jsonc` e pode ser substituída por variável.
- Resposta vazia, JSON inválido, IDs desconhecidos ou referências fora da transcrição geram retry controlado; campos não são inventados.
- Sem suporte de diarização, `speaker_label` fica nulo.

## Mudanças de prompt

1. Crie nova constante de versão.
2. Altere instrução e/ou schema.
3. Adicione fixture de resposta válida e inválida.
4. Teste preservação dos IDs e semântica de retry.
5. Mantenha materiais antigos imutáveis; uma nova geração cria nova versão.

## Provider fake

O fake é explícito, determinístico e cobre as mesmas classes de domínio. Não é fallback silencioso quando um provider real falha.
