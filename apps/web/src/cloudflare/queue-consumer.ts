import { JobProcessingError, type ProcessingJob, processingQueueMessageSchema } from "./contracts";

export interface QueueRepository {
  claim(jobId: string): Promise<ProcessingJob | null>;
  complete(jobId: string, output: Record<string, unknown>): Promise<void>;
  continue(jobId: string, output: Record<string, unknown>): Promise<void>;
  fail(
    job: ProcessingJob,
    failure: {
      code: string;
      publicMessage: string;
      transient: boolean;
      retryDelaySeconds?: number;
    }
  ): Promise<"retry_wait" | "failed" | "ignored">;
}

export interface CloudJobProcessor {
  process(job: ProcessingJob): Promise<{
    output: Record<string, unknown>;
    nextJobIds?: string[];
    continueJob?: boolean;
  }>;
}

export interface QueueDelivery {
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export function backoffSeconds(attemptCount: number, base = 5, maximum = 300): number {
  if (!Number.isInteger(attemptCount) || attemptCount < 1)
    throw new Error("attemptCount deve ser inteiro positivo");
  const exponential = Math.min(base * 2 ** (attemptCount - 1), maximum);
  const jitter = (attemptCount * 7) % Math.max(1, Math.min(base, 11));
  return Math.min(exponential + jitter, maximum);
}

function classifyFailure(error: unknown): JobProcessingError {
  if (error instanceof JobProcessingError) return error;
  return new JobProcessingError(
    "unexpected_worker_error",
    "O processamento foi interrompido. Uma nova tentativa será feita.",
    true
  );
}

export async function consumeDelivery(
  delivery: QueueDelivery,
  repository: QueueRepository,
  processor: CloudJobProcessor,
  enqueue: (jobId: string) => Promise<void>
): Promise<"completed" | "continued" | "retried" | "ignored"> {
  const message = processingQueueMessageSchema.safeParse(delivery.body);
  if (!message.success) {
    delivery.ack();
    return "ignored";
  }
  const job = await repository.claim(message.data.job_id);
  if (!job) {
    delivery.ack();
    return "ignored";
  }
  try {
    const result = await processor.process(job);
    if (result.continueJob) {
      await repository.continue(job.id, result.output);
      await enqueue(job.id);
      delivery.ack();
      return "continued";
    }
    await repository.complete(job.id, result.output);
    for (const nextJobId of result.nextJobIds ?? []) await enqueue(nextJobId);
    delivery.ack();
    return "completed";
  } catch (error) {
    const failure = classifyFailure(error);
    const status = await repository.fail(job, failure);
    if (status === "retry_wait") {
      delivery.retry({
        delaySeconds: failure.retryDelaySeconds ?? backoffSeconds(job.attempt_count)
      });
      return "retried";
    }
    delivery.ack();
    return "ignored";
  }
}
