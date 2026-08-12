# Pipeline de processamento

## Resultado operacional

O pipeline hospedado termina assim que a transcrição integral com timestamps é consolidada. Revisão por IA, materiais de estudo e PDF não são jobs da fila.

```text
upload privado
→ prepare_audio
→ transcribe_chunk
→ assemble_transcript
→ transcrição pronta (100%)
→ PDF gerado sob demanda no navegador
→ usuário leva o PDF ao ChatGPT
```

## Fila e retomada

`processing_jobs` é a fonte de verdade. O claim usa transação e `FOR UPDATE SKIP LOCKED`, com lock, heartbeat, idempotência, tentativas e recuperação de locks vencidos. Um chunk transcrito não é enviado novamente se seus segmentos já foram persistidos.

Falhas temporárias usam backoff e troca imediata de provedor. Falhas permanentes usam mensagens públicas compreensíveis e detalhes técnicos apenas nos logs.

## Preparação do áudio

- valida MIME e conteúdo;
- extrai áudio de vídeo quando necessário;
- converte para mono e taxa adequada;
- divide em blocos com sobreposição configurável;
- verifica tamanho antes do envio;
- preserva o início global de cada bloco em milissegundos.

## Transcrição e provedores

O ranking de áudio é reavaliado em cada chunk. A configuração atual pode usar Groq Whisper Large V3, AssemblyAI Universal-3 Pro, Deepgram Nova-3, Workers AI Whisper e Gemini, conforme credenciais e cotas disponíveis.

Quando um provedor recusa ou limita a chamada, o próximo é tentado imediatamente. O resultado aceito precisa conter texto e tempos válidos. Ausência de diarização mantém `speaker_label` nulo; falantes nunca são inventados.

## Consolidação

- tempo global = `chunk.start_ms + local_ms`;
- segmentos são ordenados e renumerados;
- deduplicação considera apenas a janela real de sobreposição;
- frases semelhantes fora dessa janela são preservadas;
- `raw_text` nunca é alterado;
- a versão consolidada é salva antes da aula receber 100%.

Ao concluir, `assemble_cloud_transcript` define:

- `status = completed`;
- `progress = 100`;
- `current_stage = Transcrição pronta para download`;
- nenhum job posterior.

## PDF e ChatGPT

O botão de download usa `pdf-lib` no navegador e recebe os segmentos já autorizados da página. O PDF A4 contém capa, disciplina, data, versão, transcrição integral, intervalos do áudio, cabeçalho, rodapé e paginação. Ele é baixado diretamente; não há upload, job `generate_pdf` nem dependência de Chromium no servidor.

O painel também fornece um prompt para o usuário anexar o PDF ao ChatGPT e solicitar leitura contínua, questões, apostila, flashcards, mapa mental e resumo.
