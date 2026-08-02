import { describe, expect, it, vi } from "vitest";
import type { ProcessingJob } from "./contracts";
import { backoffSeconds, consumeDelivery, type QueueDelivery } from "./queue-consumer";

const job: ProcessingJob = {
  id: "00000000-0000-4000-8000-000000000001",
  class_id: "00000000-0000-4000-8000-000000000002",
  user_id: "00000000-0000-4000-8000-000000000003",
  job_type: "prepare_audio",
  status: "running",
  attempt_count: 1,
  max_attempts: 4,
  input_json: {}
};

function delivery(body: unknown) {
  return {
    body,
    ack: vi.fn(() => undefined),
    retry: vi.fn(() => undefined)
  } satisfies QueueDelivery;
}

describe("consumidor da fila Cloudflare", () => {
  it("confirma a entrega somente depois de persistir o resultado", async () => {
    const item = delivery({ job_id: job.id });
    const complete = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const result = await consumeDelivery(
      item,
      { claim: vi.fn().mockResolvedValue(job), complete, fail: vi.fn() },
      {
        process: vi.fn().mockResolvedValue({ output: { ok: true }, nextJobIds: [job.class_id] })
      },
      enqueue
    );
    expect(result).toBe("completed");
    expect(complete).toHaveBeenCalledWith(job.id, { ok: true });
    expect(enqueue).toHaveBeenCalledWith(job.class_id);
    expect(item.ack).toHaveBeenCalledOnce();
    expect(item.retry).not.toHaveBeenCalled();
  });

  it("agenda backoff para falha temporária", async () => {
    const item = delivery({ job_id: job.id });
    const result = await consumeDelivery(
      item,
      {
        claim: vi.fn().mockResolvedValue(job),
        complete: vi.fn(),
        fail: vi.fn().mockResolvedValue("retry_wait")
      },
      { process: vi.fn().mockRejectedValue(new Error("interrompido")) },
      vi.fn()
    );
    expect(result).toBe("retried");
    expect(item.retry).toHaveBeenCalledWith({ delaySeconds: backoffSeconds(1) });
    expect(item.ack).not.toHaveBeenCalled();
  });

  it("ignora mensagens inválidas e jobs já reclamados", async () => {
    const invalid = delivery({ job_id: "não-é-uuid" });
    const repository = {
      claim: vi.fn().mockResolvedValue(null),
      complete: vi.fn(),
      fail: vi.fn()
    };
    expect(await consumeDelivery(invalid, repository, { process: vi.fn() }, vi.fn())).toBe(
      "ignored"
    );
    expect(invalid.ack).toHaveBeenCalledOnce();
    expect(repository.claim).not.toHaveBeenCalled();

    const duplicate = delivery({ job_id: job.id });
    expect(await consumeDelivery(duplicate, repository, { process: vi.fn() }, vi.fn())).toBe(
      "ignored"
    );
    expect(duplicate.ack).toHaveBeenCalledOnce();
  });
});
