import { JobProcessingError, type ProcessingJob, processingQueueMessageSchema } from "./contracts";

export interface QueueRepository {
  claim(jobId: string): Promise<ProcessingJob | null>;
  renew?(jobId: string): Promise<boolean>;
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

// O menor TTL aceito pelo banco é 30 s; renovar em 20 s mantém margem mesmo
// se a configuração for reduzida no futuro.
const LOCK_RENEWAL_INTERVAL_MS = 20_000;

async function processWithLockRenewal(
  job: ProcessingJob,
  repository: QueueRepository,
  processor: CloudJobProcessor
): Promise<Awaited<ReturnType<CloudJobProcessor["process"]>>> {
  if (!repository.renew) return processor.process(job);

  const interval = setInterval(() => {
    // Uma falha isolada de heartbeat não deve descartar o resultado de uma
    // chamada paga que ainda está em andamento. O próximo heartbeat tenta de
    // novo e, se o lock realmente vencer, o claim idempotente faz a retomada.
    void repository.renew?.(job.id).catch(() => undefined);
  }, LOCK_RENEWAL_INTERVAL_MS);

  try {
    return await processor.process(job);
  } finally {
    clearInterval(interval);
  }
}

export interface CloudJobProcessor {
  process(job: ProcessingJob): Promise<{
    output: Record<string, unknown>;
    nextJobIds?: string[];
    continueJob?: boolean;
    continueDelaySeconds?: number;
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
  enqueue: (jobId: string, options?: { delaySeconds?: number }) => Promise<void>
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
    const result = await processWithLockRenewal(job, repository, processor);
    if (result.continueJob) {
      await repository.continue(job.id, result.output);
      if (result.continueDelaySeconds) {
        await enqueue(job.id, { delaySeconds: result.continueDelaySeconds });
      } else {
        await enqueue(job.id);
      }
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
