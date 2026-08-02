import { z } from "zod";

export async function dispatchProcessingJob(jobId: string): Promise<void> {
  const parsedId = z.uuid().parse(jobId);
  if (process.env.PROCESSING_DISPATCH_MODE !== "cloudflare") return;
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const { env } = getCloudflareContext();
  await env.PROCESSING_QUEUE.send({ job_id: parsedId });
}
