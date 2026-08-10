# API do MVP

Os Route Handlers ficam sob `/api`. Todos exigem cookie de sessão Supabase, exceto o callback de Auth. Payloads usam JSON; erros seguem `{ "error": { "code", "message", "details?" } }`. O servidor valida o proprietário e o banco reaplica RLS.

## Administração de usuários

- `GET /api/admin/users`: lista contas, perfis e aprovação (administrador).
- `POST /api/admin/users`: cria administrador aprovado ou membro pendente.
- `PATCH /api/admin/users`: aprova, rejeita ou altera o perfil de outra conta.
- `DELETE /api/admin/users?userId=<uuid>`: exclui somente uma conta membro e seus dados.

Todas as rotas validam a sessão e o perfil no servidor. A chave `service_role` é usada
somente no servidor para operações do Supabase Auth.

## Disciplinas

| Método   | Rota                | Corpo/resultado                                      |
| -------- | ------------------- | ---------------------------------------------------- |
| `GET`    | `/api/subjects`     | Membro lista as próprias; administrador lista todas. |
| `POST`   | `/api/subjects`     | `{ name, description? }`; cria.                      |
| `PATCH`  | `/api/subjects/:id` | Altera nome/descrição.                               |
| `DELETE` | `/api/subjects/:id` | Exclui somente se não houver aulas.                  |

## Aulas e processamento

| Método | Rota                         | Corpo/resultado                                         |
| ------ | ---------------------------- | ------------------------------------------------------- |
| `POST` | `/api/classes`               | Disciplina, título, assunto, data, idioma e metadados.  |
| `POST` | `/api/classes/:id/process`   | Cria `prepare_audio` idempotente após upload concluído. |
| `GET`  | `/api/classes/:id/progress`  | Status, etapa, progresso, chunks e erros seguros.       |
| `POST` | `/api/classes/:id/retry`     | Reabre somente jobs falhos recuperáveis.                |
| `GET`  | `/api/classes/:id/audio-url` | URL assinada curta para o player.                       |

## Upload direto

`POST /api/uploads/start`:

```json
{
  "class_id": "uuid",
  "file_type": "audio",
  "original_name": "aula.wav",
  "mime_type": "audio/wav",
  "size_bytes": 128044,
  "sha256": "64-hex",
  "duration_ms": 42000
}
```

Cria path interno aleatório. Áudio usa TUS diretamente no Storage, com partes de 6 MB, progresso, retry e retomada; PDF e complementos usam URL assinada.

`POST /api/uploads/complete` recebe `{ file_id }`, confirma que o objeto existe e marca o registro. Duplicatas retornam conflito antes de criar job. PDF e complementos usam os mesmos endpoints com tipos permitidos.

Administradores podem criar uma aula própria dentro de qualquer disciplina visível. A propriedade da aula continua sendo de quem a incluiu; membros só conseguem selecionar as próprias disciplinas.

## Transcrição

| Método  | Rota                          | Corpo/resultado                                                                                |
| ------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET`   | `/api/classes/:id/transcript` | Segmentos ordenados, tempos em ms e issues.                                                    |
| `PATCH` | `/api/segments/:id`           | `{ revised_text, action }`; action: `save`, `confirm`, `keep_original` ou `accept_suggestion`. |
| `PATCH` | `/api/issues/:id`             | `{ action: "resolve"                                                                           | "dismiss" }`. |

`raw_text` não é aceito em updates. A web usa a versão corrente corrigida automaticamente; a edição permanece opcional e nunca é exigida para liberar materiais.

## Materiais

| Método  | Rota                            | Corpo/resultado                                                                         |
| ------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| `GET`   | `/api/classes/:id/materials`    | Lista versões e estado.                                                                 |
| `POST`  | `/api/classes/:id/materials`    | `{ material_type }`; `notes`, `summary`, `flashcards`, `questions`, `mindmap` ou `pdf`. |
| `GET`   | `/api/materials/:id/download`   | Redireciona para URL assinada curta do export privado.                                  |
| `POST`  | `/api/materials/:id/pdf-upload` | Autoriza a renderização cliente e retorna URL assinada de upload.                       |
| `PATCH` | `/api/materials/:id/pdf-upload` | Confirma o objeto PDF ou registra falha segura.                                         |

A geração retorna `202`. Um material pendente do mesmo tipo é reutilizado; uma nova versão só nasce após a anterior terminar. O endpoint rejeita transcrição ausente ou segmentos cuja correção automática ainda não terminou.

O PDF usa diretamente a transcrição corrigida com timestamps e não depende da apostila nem de uma chamada adicional de IA.

No modo Cloudflare, jobs criados são persistidos primeiro e somente o `job_id` é enviado à Queue. Se a entrega falhar, o cron recupera o job; handlers nunca colocam áudio ou transcrição na mensagem. A geração PDF é autorizada pelo servidor, executada no navegador com `pdf-lib` e concluída somente depois que o Storage confirma o objeto privado.

## Códigos usuais

- `400`: requisição inválida.
- `401`: sessão ausente/expirada.
- `404`: recurso inexistente ou de outro usuário.
- `409`: duplicata, revisão pendente ou estado incompatível.
- `413`: arquivo acima do limite.
- `415`: MIME/extensão não permitidos.
- `422`: schema inválido.
- `500`: falha interna com mensagem segura.
- `201/202`: criado/colocado na fila.

## Polling

A tela consulta progresso e segmentos em intervalo controlado; materiais pendentes são atualizados a cada dois segundos. Os percentuais vêm de marcos persistidos e contagem de chunks, nunca de cronômetro.
