# ADR 0008 — Upload retomável de áudio no plano gratuito

## Status

Aceita em 10 de agosto de 2026.

## Contexto

O limite inicial de 15 MB impedia aulas comuns de aproximadamente 39 MB. O Cloudflare R2 foi avaliado, mas a conta exige habilitação específica do produto e pode permitir cobrança por excedente. Isso contraria a exigência de não criar custos.

## Decisão

- Elevar o limite do áudio para 50 MB, teto atual por arquivo do Supabase Free.
- Manter o bucket `class-audio` privado.
- Usar o protocolo TUS diretamente do navegador em partes de 6 MB, com retry e retomada.
- Separar o limite da origem (`MAX_AUDIO_UPLOAD_SIZE_MB=50`) do limite inline dos modelos (`MAX_TRANSCRIPTION_CHUNK_MB=15`).
- Transmitir arquivos maiores para AssemblyAI/Deepgram e pular provedores cujo limite inline não comporte o arquivo.
- Não habilitar R2 nem cadastrar cobrança automaticamente.

## Consequências

O arquivo de 39 MB passa a funcionar sem contratar infraestrutura. O Supabase Free inclui 1 GB total de Storage: quando a franquia for alcançada, novos uploads serão recusados, não cobrados. O usuário pode excluir aulas antigas; uma política automática de retenção exigirá uma decisão separada sobre por quanto tempo preservar o áudio original.
