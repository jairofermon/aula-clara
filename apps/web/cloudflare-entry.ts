// O módulo é gerado por `opennextjs-cloudflare build`.
// @ts-expect-error módulo gerado somente durante o build Cloudflare
import nextHandler from "./.open-next/worker.js";
import { createCloudJobProcessor } from "./src/cloudflare/cloud-job-processor";
import type { ProcessingQueueMessage } from "./src/cloudflare/contracts";
import { consumeDelivery } from "./src/cloudflare/queue-consumer";
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
        async (jobId, options) => {
          await env.PROCESSING_QUEUE.send({ job_id: jobId }, options);
        }
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
    const jobIds = await repository.readyJobIds();
    if (jobIds.length) {
      await env.PROCESSING_QUEUE.sendBatch(jobIds.map((jobId) => ({ body: { job_id: jobId } })));
    }
    console.log(JSON.stringify({ event: "processing_queue.sweep", queued_jobs: jobIds.length }));
  }
} satisfies ExportedHandler<CloudflareEnv, ProcessingQueueMessage>;
