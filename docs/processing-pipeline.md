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
review_transcript (trecho a trecho)
          ↓
review_transcript (leitura global)
          ↓
generate_summary → aula pronta para estudar

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

Na publicação web, o áudio original fica no Supabase Storage privado e é enviado por TUS em partes retomáveis de 6 MB. O limite do arquivo de origem (50 MB) é independente do limite de entrada direta de cada modelo. AssemblyAI e Deepgram recebem um stream novo do Storage; Groq, Workers AI e Gemini são tentados somente quando o arquivo cabe em seus limites seguros. Duração é extraída no navegador e confirmada pelo pipeline.

Não há FFmpeg no Cloudflare nesta etapa. MP3/WAV/WebM/M4A compatível segue por streaming aos provedores de transcrição de arquivos longos; contêiner que exija conversão deve ser convertido antes do upload. Chunking por silêncio/overlap e extração de vídeo permanecem implementados no worker Python.

## Transcrição

`TranscriptionProvider.transcribe()` recebe path local, idioma, dica contextual limitada e opção de diarização. O resultado normalizado contém texto, início/fim em milissegundos, falante opcional e confiança opcional.

- O provider OpenAI usa configuração centralizada.
- O roteador tenta Groq Whisper Large V3, AssemblyAI Universal-3 Pro, Deepgram Nova-3, Workers AI e Gemini habilitado, nessa ordem.
- Limite, indisponibilidade ou credencial recusada em um fornecedor provoca troca imediata; somente o esgotamento de todas as rotas produz retry persistido.
- Gemini só é usado quando a chave e `GEMINI_DATA_PROCESSING_CONSENT=accepted` estão presentes.
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

O Whisper pode devolver centenas de fragmentos de poucos segundos. Quando a versão original ultrapassa 200 segmentos, o pipeline preserva essa versão 1 para auditoria e cria uma versão operacional compacta, agrupando 12 fragmentos consecutivos. Os limites globais em milissegundos continuam exatos e a tela deixa de exibir centenas de cartões sem contexto.

Os segmentos operacionais são enviados em lotes de até 16 itens. Para evitar que o modelo copie incorretamente UUIDs longos, cada chamada usa índices curtos e ordenados; o servidor associa os índices de volta aos IDs imutáveis. A resposta final contém somente índice, texto corrigido e confiança e passa por schema Zod estrito. Cada provedor dispõe de até oito segundos nessa etapa. Se nenhum deles entregar uma resposta válida, o lote original imutável é preservado e o pipeline avança para a revisão global, que recebe uma segunda oportunidade de corrigi-lo. Um segmento individual longo pode ser dividido por frases em partes de até 1.200 caracteres e reunido com o mesmo timestamp. Nenhum trecho isolado ou resposta malformada bloqueia a entrega da aula inteira.

Quando resta apenas um segmento e o modelo ainda não consegue produzir JSON válido, o worker solicita a correção como texto simples. Se essa resposta vier vazia, resumida ou excessivamente longa, o texto bruto preservado é usado para concluir o trecho. Erros de formato do fornecedor, portanto, não interrompem mais a aula nem exigem ação manual.

Para aulas longas, cada entrega da Queue processa no máximo dez lotes. O worker então persiste uma continuação, libera o lock e reenfileira o mesmo `job_id` sem contabilizar a continuação como falha. O cron consulta jobs pendentes, retries vencidos e jobs `running`; a função transacional de claim só aceita estes últimos quando o lock expirou. Assim, ele continua sendo a rede de segurança caso a nova mensagem não seja entregue ou um worker seja interrompido.

Todo trecho corrigido recebe `auto_reviewed` e não exige confirmação manual. Depois desse passe, uma chamada separada lê a transcrição completa em ordem, confirma a cobertura de todos os segmentos e persiste somente correções adicionais validadas. Incerteza do modelo não interrompe o fluxo: ele preserva a formulação mais fiel e o timestamp permite a conferência opcional no áudio. O usuário ainda pode editar qualquer trecho; a edição é salva como `user_edited`.

`raw_text` nunca é alterado. `revised_text`, confiança e status são gravados na mesma transação. Ao concluir todos os lotes, a aula fica pronta para materiais automaticamente.

## Texto efetivo

Para materiais, cada segmento usa:

1. texto editado pelo usuário, se houver;
2. `revised_text` corrigido automaticamente;
3. `raw_text` somente enquanto o lote ainda não foi corrigido.

A geração é liberada depois da revisão global. O resumo é automático e libera a aula para estudo; apostila, flashcards, questões e mapa mental entram em prioridade inferior para não atrasar a próxima aula.

Todos os materiais de estudo são obrigatoriamente produzidos por IA. A transcrição é dividida em partes de tamanho seguro e cada parte percorre o ranking completo de provedores. As respostas estruturadas são consolidadas, desduplicadas e submetidas novamente às regras de qualidade e cobertura da aula inteira. Isso evita estouro de contexto sem substituir inteligência por cópia extrativa.

Apostila exige capítulos temáticos e proíbe horários como títulos; flashcards exigem perguntas conceituais autossuficientes; questões exigem enunciado contextualizado, cinco alternativas plausíveis e explicações; mapa mental exige rótulos conceituais e hierarquia. Materiais genéricos, transcrição disfarçada de apostila ou perguntas sobre “o trecho” são rejeitados. Se todos os provedores estiverem indisponíveis, o job permanece em retomada automática e nunca recebe o status falso de pronto. Enquanto houver material pendente, a API exibe progresso real entre 96% e 99%; 100% é reservado ao pacote validado.

## Capacidade e failover

Cada resultado limitado ou potencialmente cobrado é persistido antes de completar o job. Reentrega e troca de fornecedor consultam essa persistência e não repetem uma etapa concluída. Cerebras, Groq, Cloudflare, Gemini e OpenRouter possuem limites independentes; o sistema usa o primeiro resultado válido e registra modelo, duração e unidades. Quando um provedor falha, o mesmo ciclo consulta imediatamente todos os seguintes. Se todos estiverem simultaneamente indisponíveis, o job permanece em `retry_wait` por 15 a 60 segundos e reinicia o ranking automaticamente, sem botão e sem limite terminal de tentativas para etapas de IA.

O ranking é reavaliado no início de cada chunk ou lote, permitindo que o provedor principal volte a ser usado assim que se recuperar:

1. áudio: Groq Whisper Large V3, AssemblyAI Universal-3 Pro, Deepgram Nova-3, Workers AI Whisper e Gemini;
2. revisão por trecho: Cerebras GPT OSS 120B, Groq Llama Instant, Gemini Flash, Workers AI Llama e OpenRouter Free;
3. revisão global e materiais: Cerebras GPT OSS 120B, Groq Compound, Gemini Flash, Workers AI Llama e OpenRouter Free.

Uma resposta só conta como disponibilidade quando também passa pelo schema e pelas regras semânticas da operação. HTTP 200 com JSON inválido não faz o pipeline avançar.

## PDF

No deploy gratuito, o servidor autoriza a operação e entrega somente a transcrição corrigida do proprietário. O navegador monta o PDF com `pdf-lib`, incluindo capa, cabeçalho/rodapé, timestamps, versão e paginação, e envia o binário diretamente por URL assinada ao bucket `generated-exports`. O PDF não depende de outra chamada de IA. Uma segunda chamada confirma a presença do objeto antes de marcar o material como concluído.

No worker Python local, o caminho equivalente monta HTML escapado e usa Chromium headless pelo Playwright. Em nenhum modo o modelo produz binário PDF.
