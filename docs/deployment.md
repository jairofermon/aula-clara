# Deploy

Este repositório não publica automaticamente e não cria recursos pagos. O alvo natural é uma instância Supabase gerenciada, uma imagem web e uma ou mais réplicas da imagem do worker.

## Artefatos

- `apps/web/Dockerfile`: build standalone do Next.js em Node 22.
- `services/worker/Dockerfile`: Python 3.12, FFmpeg, dependências e Chromium.
- `docker-compose.yml`: desenvolvimento; não é um manifesto de produção.

## Sequência recomendada

1. Criar o projeto Supabase e configurar as URLs de callback.
2. Aplicar migrations com Supabase CLI em uma identidade de deploy.
3. Criar segredos no cofre da plataforma; nunca como build arg, exceto valores `NEXT_PUBLIC_*`.
4. Construir a web com a origem pública e chave anon do ambiente.
5. Publicar o worker com acesso TLS ao PostgreSQL e à API Storage.
6. Iniciar uma réplica, validar fila/custos e só então aumentar concorrência.
7. Executar smoke test com provider fake em staging e integração OpenAI opt-in.

## Variáveis por componente

Web:

- `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- `SUPABASE_INTERNAL_URL` quando a rota interna difere da pública.
- `MAX_UPLOAD_SIZE_MB`, `SIGNED_URL_TTL_SECONDS`.

Worker:

- `SUPABASE_DB_URL`, `SUPABASE_INTERNAL_URL` ou `NEXT_PUBLIC_SUPABASE_URL`.
- `SUPABASE_SERVICE_ROLE_KEY`.
- `PROVIDER_MODE`, `OPENAI_API_KEY` e três modelos.
- chunk, lock, polling, custos e log level.

## Banco e concorrência

O protocolo aceita vários workers porque o claim usa `FOR UPDATE SKIP LOCKED`. Cada réplica deve ter `WORKER_ID` único. O pool deve respeitar o limite do Supabase; comece com uma réplica. A conexão de produção precisa exigir TLS e usar o endpoint direto/pooler recomendado para jobs longos.

## Health e operação

O perfil `diagnostics` expõe o FastAPI em `/health`, sem comandos de processamento. Use-o para probes se a plataforma precisar. O processo principal do worker deve ser reiniciado em falha; leases expirados tornam jobs recuperáveis.

Alertas mínimos:

- jobs `failed` ou `running` além do TTL;
- crescimento de `retry_wait`, rate limit e quota;
- tempo de preparação/transcrição/PDF;
- custo estimado e áudio processado;
- armazenamento e conexões do banco.

## Rollback

Imagens devem ser tagueadas por commit. Prefira migrations aditivas e compatibilidade N/N-1 entre web, worker e esquema. Rollback de código não deve remover colunas; reversão destrutiva exige backup e procedimento separado.

## Antes de produção

Implementar rate limiting, quotas/custos, retenção automática, gestão LGPD, antivírus, rotação de segredos, backups testados, CSP e observabilidade centralizada. O provider fake não deve ser selecionado silenciosamente em produção.
