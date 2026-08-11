import type { CloudJobProcessor, QueueRepository } from "./queue-consumer";
import { consumeDelivery } from "./queue-consumer";

export interface ScheduledJobRepository extends QueueRepository {
  readyJobIds(limit?: number): Promise<string[]>;
}

/**
 * Executa diretamente os jobs persistidos, sem reenfileirar cada lote.
 *
 * A fila continua acelerando a primeira entrega quando houver cota. O agendador
 * é o caminho confiável e gratuito: cada continuação volta a `pending` no banco
 * e pode ser processada novamente no mesmo disparo, até o limite de passos.
 */
export async function processScheduledJobs(
  repository: ScheduledJobRepository,
  processor: CloudJobProcessor,
  maxSteps = 3
): Promise<number> {
  let processed = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    const [jobId] = await repository.readyJobIds(1);
    if (!jobId) break;

    const result = await consumeDelivery(
      {
        body: { job_id: jobId },
        ack: () => undefined,
        retry: () => undefined
      },
      repository,
      processor,
      async () => undefined
    );

    // Outro consumidor pode ter reclamado o mesmo job entre a listagem e o
    // claim. Isso não deve interromper o sweep e deixar os demais aguardando.
    if (result !== "ignored") processed += 1;
  }

  return processed;
}
