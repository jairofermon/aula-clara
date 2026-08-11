# Fluxo manual com ChatGPT/Codex

## Objetivo

O fluxo principal gratuito encerra o processamento automático quando a transcrição bruta com timestamps está consolidada. A revisão profunda e a criação dos materiais são realizadas de forma interativa no ChatGPT ou Codex, sem usar a API paga da OpenAI.

## Passos do usuário

1. Enviar o áudio e, opcionalmente, slides e materiais complementares.
2. Aguardar a mensagem `Transcrição bruta pronta para o ChatGPT`.
3. Abrir a aula e baixar o arquivo `aula-clara-*-chatgpt.json`.
4. Anexar esse JSON e os PDFs originais ao ChatGPT/Codex.
5. Usar GPT-5.6 Sol com esforço `xhigh` ou `max` e pedir para executar integralmente o campo `instructions`.
6. Baixar `aula-clara-resultado.json` produzido pelo modelo.
7. Importar o resultado na mesma aula.

## Garantias da importação

- formato validado com Zod;
- aula e versão da transcrição precisam coincidir;
- todos os segmentos precisam aparecer exatamente uma vez;
- `raw_text` nunca é alterado;
- IDs citados nos materiais precisam existir na aula;
- timestamps precisam estar dentro da duração transcrita;
- no mínimo 10 flashcards e 10 questões;
- cinco alternativas e exatamente uma correta por questão;
- mapa mental Mermaid é construído localmente a partir da árvore validada;
- transcrição, materiais, status, uso e auditoria são persistidos em uma transação PostgreSQL.

Se alguma validação falhar, nada é importado parcialmente. O arquivo precisa ser corrigido ou recriado.

## Limite deliberado

A assinatura do ChatGPT/Codex não é usada como credencial de API pelo Aula Clara. A transferência dos dois arquivos é manual. Isso mantém o fluxo sem custo adicional de API e impede que a indisponibilidade de provedores gratuitos bloqueie a transcrição.
