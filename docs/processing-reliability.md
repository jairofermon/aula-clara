# Contrato de confiabilidade do processamento

## Resultado esperado

Uma aula é considerada concluída somente quando possui:

1. áudio armazenado e validado;
2. transcrição integral com tempos numéricos;
3. revisão por IA comprovada para todos os segmentos;
4. revisão contextual final da aula;
5. PDF da transcrição;
6. resumo, apostila, flashcards, questões e mapa mental canônicos.

Avançar a barra não substitui nenhum desses resultados.

## Início: entrada e preparação

- O navegador envia arquivos diretamente ao armazenamento privado.
- O hash evita processar duas vezes o mesmo arquivo na mesma aula.
- O job `prepare_audio` é idempotente e cria blocos somente quando ainda não existem.
- Arquivos grandes usam upload retomável; uma interrupção não reinicia do zero.

## Meio: transcrição e revisão

- A transcrição consulta os provedores gratuitos em ranking e persiste cada resposta válida.
- `raw_text` é imutável.
- A revisão trabalha em lotes pequenos. Cada lote válido é gravado antes do seguinte.
- Erro de estrutura reduz o lote progressivamente até um único segmento.
- Falha de todos os provedores não pode copiar o texto bruto e chamá-lo de revisão.
- A revisão global precisa receber resposta válida antes de validar a versão da transcrição.
- Materiais são bloqueados enquanto houver segmento sem revisão real ou versão não validada.

## Fim: pacote de estudo

- Há um material canônico por tipo; trocar provedor não cria v2/v3 para o usuário.
- Cada parte de um material longo é persistida em `processing_jobs.output_json`.
- Uma retomada começa na primeira parte ausente e não repete chamadas concluídas.
- PDF concluído não marca a aula como pronta enquanto outro material estiver pendente.
- O progresso do pacote é a razão entre materiais canônicos concluídos e esperados.

## Recuperação automática

- Jobs em execução renovam o lock a cada 30 segundos.
- O lock expira após 120 segundos sem heartbeat.
- O agendador consulta jobs prontos e também locks vencidos a cada minuto.
- Um job órfão volta para a fila, preservando segmentos e partes já persistidos.
- Claims usam transação e lock no PostgreSQL; duas execuções não podem concluir a mesma etapa.

## Estados terminais

- `completed`: artefato persistido e validado.
- `retry_wait`: indisponibilidade temporária; retomada automática.
- `failed`: entrada inválida ou ação humana indispensável.

Nenhum estado `running`, `pending` ou `generating` é terminal.

## Limite honesto da gratuidade

O sistema garante integridade, idempotência e retomada. Ele não pode garantir que uma API
gratuita externa responderá dentro de um prazo fixo. Se todas as cotas estiverem indisponíveis,
o job permanece em `retry_wait` e continua tentando sem perder progresso ou produzir falso
sucesso. A meta operacional é usar divisão pequena e failover imediato para aproveitar a
primeira capacidade gratuita disponível.
