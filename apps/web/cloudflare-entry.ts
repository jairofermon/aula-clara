// O módulo é gerado por `opennextjs-cloudflare build`.
// @ts-expect-error módulo gerado somente durante o build Cloudflare
import nextHandler from "./.open-next/worker.js";
import { createCloudJobProcessor } from "./src/cloudflare/cloud-job-processor";
import type { ProcessingQueueMessage } from "./src/cloudflare/contracts";
import { consumeDelivery } from "./src/cloudflare/queue-consumer";
import { processScheduledJobs } from "./src/cloudflare/scheduled-processor";
import { SupabaseJobRepository } from "./src/cloudflare/supabase-job-repository";

export default {
  fetch: nextHandler.fetch,

  async queue(batch: MessageBatch<ProcessingQueueMessage>, env: CloudflareEnv) {
    for (const message of batch.messages) {
      const deliveryEnv = Object.assign(Object.create(env) as CloudflareEnv, {
        WORKER_ID: `${env.WORKER_ID}:${crypto.randomUUID()}`
      });
      const repository = new SupabaseJobRepository(deliveryEnv);
      const processor = createCloudJobProcessor(deliveryEnv, repository);
      const result = await consumeDelivery(
        message,
        repository,
        processor,
        // A continuação fica persistida no PostgreSQL. O cron abaixo a retoma
        // sem gastar uma nova operação da fila a cada lote de IA.
        async () => undefined
      );
      console.log(
        JSON.stringify({
          event: "processing_queue.delivery",
          job_id: message.body?.job_id ?? null,
          result
        })
      );
    }
  },

  async scheduled(_controller: ScheduledController, env: CloudflareEnv) {
    const repository = new SupabaseJobRepository(env);
    const processor = createCloudJobProcessor(env, repository);
    const processedJobs = await processScheduledJobs(repository, processor, 3);
    console.log(
      JSON.stringify({ event: "processing_scheduler.sweep", processed_jobs: processedJobs })
    );
  }
} satisfies ExportedHandler<CloudflareEnv, ProcessingQueueMessage>;
