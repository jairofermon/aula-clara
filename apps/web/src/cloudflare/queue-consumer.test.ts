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
  input_json: {},
  output_json: {}
};

function delivery(body: unknown) {
  return {
    body,
    ack: vi.fn(() => undefined),
    retry: vi.fn(() => undefined)
  } satisfies QueueDelivery;
}

describe("consumidor da fila Cloudflare", () => {
  it("renova o lock durante uma etapa demorada", async () => {
    vi.useFakeTimers();
    let finish!: (value: { output: Record<string, unknown> }) => void;
    const processing = new Promise<{ output: Record<string, unknown> }>((resolve) => {
      finish = resolve;
    });
    const renew = vi.fn().mockResolvedValue(true);
    const item = delivery({ job_id: job.id });
    const consuming = consumeDelivery(
      item,
      {
        claim: vi.fn().mockResolvedValue(job),
        renew,
        complete: vi.fn(),
        continue: vi.fn(),
        fail: vi.fn()
      },
      { process: vi.fn().mockReturnValue(processing) },
      vi.fn()
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(renew).toHaveBeenCalledWith(job.id);
    finish({ output: { ok: true } });
    await expect(consuming).resolves.toBe("completed");
    vi.useRealTimers();
  });

  it("confirma a entrega somente depois de persistir o resultado", async () => {
    const item = delivery({ job_id: job.id });
    const complete = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const result = await consumeDelivery(
      item,
      { claim: vi.fn().mockResolvedValue(job), complete, continue: vi.fn(), fail: vi.fn() },
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

  it("libera e reenfileira uma continuação sem concluir o job", async () => {
    const item = delivery({ job_id: job.id });
    const complete = vi.fn();
    const continueJob = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const result = await consumeDelivery(
      item,
      {
        claim: vi.fn().mockResolvedValue(job),
        complete,
        continue: continueJob,
        fail: vi.fn()
      },
      { process: vi.fn().mockResolvedValue({ output: { reviewed: 240 }, continueJob: true }) },
      enqueue
    );

    expect(result).toBe("continued");
    expect(continueJob).toHaveBeenCalledWith(job.id, { reviewed: 240 });
    expect(complete).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(job.id);
    expect(item.ack).toHaveBeenCalledOnce();
  });

  it("respeita a cadência do provedor ao continuar um job", async () => {
    const item = delivery({ job_id: job.id });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    await consumeDelivery(
      item,
      {
        claim: vi.fn().mockResolvedValue(job),
        complete: vi.fn(),
        continue: vi.fn().mockResolvedValue(undefined),
        fail: vi.fn()
      },
      {
        process: vi.fn().mockResolvedValue({
          output: { reviewed: 4 },
          continueJob: true,
          continueDelaySeconds: 65
        })
      },
      enqueue
    );

    expect(enqueue).toHaveBeenCalledWith(job.id, { delaySeconds: 65 });
    expect(item.ack).toHaveBeenCalledOnce();
  });

  it("agenda backoff para falha temporária", async () => {
    const item = delivery({ job_id: job.id });
    const result = await consumeDelivery(
      item,
      {
        claim: vi.fn().mockResolvedValue(job),
        complete: vi.fn(),
        continue: vi.fn(),
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
      continue: vi.fn(),
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
