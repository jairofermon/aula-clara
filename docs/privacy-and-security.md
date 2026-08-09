# Privacidade e segurança

## Dados e responsabilidades

Gravações, slides e transcrições podem conter dados pessoais, educacionais ou de saúde. A interface avisa que o usuário deve possuir autorização para gravar e processar a aula. A implantação real deve definir base legal, prazo de retenção, canal para titulares e termos de uso compatíveis com a jurisdição.

## Controles implementados

- Supabase Auth e rotas privadas protegidas por sessão.
- RLS em todas as tabelas com dados de usuário; os grants habilitam operações, enquanto as policies restringem cada linha a `auth.uid()`.
- FKs compostas garantem que aula, arquivo e job pertencem ao mesmo usuário.
- As funções SQL de claim/lease não podem ser executadas por `anon` ou `authenticated`.
- Buckets `class-audio`, `class-materials` e `generated-exports` são privados.
- Paths começam por `user_id`; uploads e downloads usam URLs assinadas curtas.
- Upload direto evita que arquivos grandes atravessem a memória do processo Next.js.
- Nome interno usa UUID; nome original fica somente em metadados.
- Extensão, MIME, tamanho, hash SHA-256 e presença do objeto são verificados.
- A unicidade `(class_id, sha256, file_type)` impede processamento duplicado dentro da aula.
- `raw_text` é protegido por trigger e nunca é sobrescrito; revisão vai para `revised_text`.
- Mermaid opera com `securityLevel: strict` e o SVG passa por DOMPurify. PDF usa template próprio e escape HTML.
- `OPENAI_API_KEY`, service role e URL direta do banco não usam prefixo `NEXT_PUBLIC_` e não entram no bundle do navegador.
- `.env`, `.env.local`, relatórios e temporários são ignorados pelo Git/Docker.
- No deploy gratuito, a Cloudflare Queue transporta apenas `job_id`; áudio e transcrição não entram na mensagem.
- O consumidor Cloudflare acessa RPCs `SECURITY DEFINER` revogadas de `anon`/`authenticated` e liberadas somente para `service_role`.
- Workers AI recebe somente o chunk necessário e contexto limitado; a resposta passa por Zod estrito antes de qualquer persistência.
- Áudio só é enviado ao AssemblyAI quando Groq falha e ao Deepgram quando ambos falham; as chaves ficam exclusivamente nos secrets do Cloudflare. Gemini e OpenRouter são usados somente depois dos provedores anteriores do ranking. O nível gratuito do Gemini pode usar conteúdo para melhorar produtos; o OpenRouter pode encaminhar texto a operadores distintos.
- O PDF é montado localmente no navegador autenticado, sem enviar a apostila a um segundo serviço de renderização.

## Autorização nas APIs

Cada handler recupera o usuário com `supabase.auth.getUser()`, valida ownership e aplica schema antes da operação. A interface não é uma fronteira de segurança. URLs ou UUIDs de outro usuário retornam 404/401 sem revelar existência.

## Logs e auditoria

O worker emite JSON estruturado com `class_id`, `job_id`, `chunk_id` quando aplicável, tipo, tentativa, duração, modelo, código e status. Não registra áudio, token, chave, transcrição integral ou prompt integral. `audit_events` registra ações de produto com recurso e metadados pequenos.

Mensagens para o usuário são deliberadamente genéricas. Detalhes do fornecedor ficam em exceções/logs do worker e não são persistidos como conteúdo completo.

## Retenção e exclusão

`classes.deleted_at` prepara exclusão lógica. Cascatas cobrem os registros dependentes e buckets permitem remoção autenticada dos caminhos do proprietário. A disciplina não pode ser apagada se houver aulas, reduzindo perda acidental.

O MVP não executa purge automático. Antes de produção, criar rotina idempotente que remova objetos, registros e backups após o prazo configurado, com auditoria e janela de recuperação.

## Ameaças e resposta

| Cenário                    | Controle atual                                                            |
| -------------------------- | ------------------------------------------------------------------------- |
| UUID de outro usuário      | Ownership no handler + RLS/FKs.                                           |
| URL de arquivo vazada      | Bucket privado e expiração curta.                                         |
| Upload disfarçado          | MIME/extensão, tamanho, ffprobe/FFmpeg e parser PDF estrito.              |
| Conteúdo gerado malicioso  | Schemas estritos, sem HTML do modelo, escape e sanitização.               |
| Worker duplicado           | Claim transacional por ID, lease, idempotency key e resultado persistido. |
| Exposição de chave         | Segredos somente em env do worker; nenhum log de env.                     |
| Falha durante upload       | Registro incompleto não inicia job; conclusão verifica o objeto.          |
| Mensagem duplicada/perdida | Ack somente após conclusão; cron recupera o job no PostgreSQL.            |

## Pendências antes de produção

- Antivírus/content disarm para anexos.
- KMS/rotação de segredos e conexão PostgreSQL com TLS.
- Rate limiting por usuário e limites de custo/quota.
- Política de retenção executável e exportação/exclusão LGPD.
- Revisão de DPA/subprocessadores e localização dos dados.
- CSP, monitoramento de dependências e testes de invasão.
- OCR e scanners isolados, caso sejam adicionados.
- Avaliação formal dos termos/DPA de Supabase e Cloudflare antes de processar dados sensíveis ou médicos reais.

## Limite de segurança desta entrega

Esta vertical é adequada para validação de produto e conteúdo educacional autorizado, mas não representa certificação de conformidade LGPD nem ambiente clínico. O usuário deve evitar dados médicos identificáveis até que retenção, DPA, resposta a incidentes e avaliação jurídica estejam concluídos.
