# Pipeline de processamento

## Fila persistida e entrega

`processing_jobs` é a fonte de verdade. O worker Python chama uma função SQL que seleciona o job elegível mais antigo com `FOR UPDATE SKIP LOCKED`. No deploy Cloudflare, a Queue entrega somente `job_id` e uma RPC faz o claim transacional daquele ID. Ambos consideram leases vencidos, incrementam `attempt_count` e gravam `locked_by`, `locked_at` e `started_at`.

Durante operações longas, o worker renova o lease. Ao terminar, grava o resultado e cria dependências idempotentes. Exceções são classificadas:

- temporárias: timeout, rate limit, indisponibilidade e interrupção; usam backoff e `next_attempt_at`;
- permanentes: MIME inválido, FFmpeg ausente, áudio sem fala, PDF corrompido, chave/quota inválida e resposta estrutural repetidamente inválida.

O backoff é `min(base * 2^(attempt-1), máximo) + jitter`. Ao atingir `max_attempts`, o job falha permanentemente.

No Cloudflare, a mensagem só recebe ack após conclusão persistida. Falhas temporárias atualizam `next_attempt_at` e usam o mesmo atraso na Queue; um cron a cada cinco minutos reenfileira jobs pendentes, retries vencidos e locks expirados. Reentrega duplicada encontra job concluído e não chama o modelo.

## Grafo

```text
prepare_audio
  ├─ transcribe_chunk[0]
  ├─ transcribe_chunk[1]
  └─ ...
          ↓ (todos completos)
assemble_transcript
          ↓
review_transcript
          ├─ needs_user_review
          └─ pronto para materiais

generate_notes ─┐
generate_summary ├─ independentes e versionados
generate_flashcards
generate_questions
generate_mindmap
generate_pdf ───┘
```

## Preparação de áudio

### Worker Python completo

1. Baixar para diretório temporário privado.
2. Validar container/streams/duração com ffprobe.
3. Rejeitar ausência de stream de áudio ou duração inválida.
4. Converter para mono, 16 kHz e bitrate configurável.
5. Localizar pontos de silêncio próximos ao alvo de 10 minutos; se não houver, cortar no alvo.
6. Aplicar sobreposição configurável, mantendo `start_ms` global.
7. Verificar tamanho de cada arquivo antes de persistir.
8. Calcular SHA-256, enviar ao Storage e criar `audio_chunks`.

O diretório temporário é sempre removido em `finally`.

### Deploy web gratuito inicial

Para caber nos runtimes gratuitos sem servidor de mídia, a web limita o áudio a 15 MB e registra um único `audio_chunk` apontando para o objeto privado original. Duração é extraída no navegador e confirmada pelo pipeline. O processamento rejeita arquivo ausente, vazio, acima do limite ou sem duração válida.

Não há FFmpeg no Cloudflare nesta etapa. MP3/WAV/WebM/M4A compatível segue diretamente ao Workers AI; contêiner que exija conversão deve ser convertido antes do upload. Chunking longo, silêncio/overlap e extração de vídeo permanecem implementados no worker Python e são a expansão seguinte após medir cotas.

## Transcrição

`TranscriptionProvider.transcribe()` recebe path local, idioma, dica contextual limitada e opção de diarização. O resultado normalizado contém texto, início/fim em milissegundos, falante opcional e confiança opcional.

- O provider OpenAI usa configuração centralizada.
- O provider Cloudflare usa `@cf/openai/whisper-large-v3-turbo`, idioma `pt`, VAD e contexto limitado.
- O fake gera segmentos determinísticos para testes.
- Falantes ausentes permanecem nulos.
- Respostas sem tempos válidos são rejeitadas.
- Resultados e uso são persistidos antes de completar o job.

## Contexto

Título, disciplina, professor, glossário e texto extraído dos slides formam uma dica limitada. PDF é extraído com biblioteca apropriada, páginas e caracteres são limitados, e o binário nunca é enviado como texto.

## Consolidação e sobreposição

- Tempo global = `chunk.start_ms + local_ms`.
- Segmentos são ordenados por início e índice do chunk.
- A deduplicação só considera pares na janela coberta pela sobreposição.
- Normalização de texto é usada para comparação, mas o conteúdo original é preservado.
- Exige similaridade alta e sobreposição temporal; frases semelhantes fora da janela são mantidas.
- A sequência final é renumerada e persistida atomicamente.

## Revisão

Segmentos são enviados em lotes de até 24 itens. Para evitar que o modelo copie incorretamente UUIDs longos, cada chamada usa índices curtos e ordenados; o servidor associa os índices de volta aos IDs imutáveis. A resposta passa por schema Zod/Pydantic estrito. O lote inteiro é descartado se houver índice ausente/desconhecido, duplicação, campo extra inválido ou valor fora de faixa. Quando o modelo não preserva todos os índices ou devolve JSON/schema inválido, o worker subdivide o lote recursivamente e valida cada novo lote antes de persistir, evitando repetir trechos já revisados.

Para aulas longas, cada entrega da Queue processa no máximo dez lotes. O worker então persiste uma continuação, libera o lock e reenfileira o mesmo `job_id` sem contabilizar a continuação como falha. O cron consulta jobs pendentes, retries vencidos e jobs `running`; a função transacional de claim só aceita estes últimos quando o lock expirou. Assim, ele continua sendo a rede de segurança caso a nova mensagem não seja entregue ou um worker seja interrompido.

Trechos revisados sem alerta recebem `auto_reviewed` e não exigem confirmação manual. Somente segmentos classificados como `needs_review`, com uma pendência aberta, interrompem o fluxo para conferência humana. O usuário ainda pode editar qualquer trecho aprovado automaticamente; a edição é salva como `user_edited`.

`raw_text` nunca é alterado. `revised_text`, confiança, status e issues são gravados na mesma transação. A aula entra em `needs_user_review` quando houver issue aberta; caso contrário fica pronta para materiais.

## Texto efetivo

Para materiais, cada segmento usa:

1. texto editado/confirmado pelo usuário;
2. `revised_text` auto-revisado sem pendência;
3. `raw_text` apenas quando explicitamente confirmado como original.

Se existir pendência aberta, a geração é recusada para não usar transcrição não validada.

## PDF

No deploy gratuito, o servidor autoriza a operação e entrega apenas a apostila validada do proprietário. O navegador monta o PDF com `pdf-lib`, incluindo capa, índice cronológico, cabeçalho/rodapé, timestamps, versão e paginação, e envia o binário diretamente por URL assinada ao bucket `generated-exports`. Uma segunda chamada confirma a presença do objeto antes de marcar o material como concluído.

No worker Python local, o caminho equivalente monta HTML escapado e usa Chromium headless pelo Playwright. Em nenhum modo o modelo produz binário PDF.
