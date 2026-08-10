import { describe, expect, it, vi } from "vitest";
import type { ProcessingJob } from "./contracts";
import { processScheduledJobs, type ScheduledJobRepository } from "./scheduled-processor";

const job: ProcessingJob = {
  id: "7f9d91e2-8f48-4dad-a9f9-4ba186ca3485",
  class_id: "8b29bb2f-593c-4942-9cff-dfb9e24a0878",
  user_id: "996c3747-da69-4860-bcdd-497f682bed60",
  job_type: "generate_summary",
  status: "running",
  attempt_count: 1,
  max_attempts: 12,
  input_json: {},
  output_json: {}
};

describe("processScheduledJobs", () => {
  it("continua jobs pelo banco sem produzir novas mensagens na fila", async () => {
    const repository: ScheduledJobRepository = {
      readyJobIds: vi
        .fn()
        .mockResolvedValueOnce([job.id])
        .mockResolvedValueOnce([job.id])
        .mockResolvedValueOnce([]),
      claim: vi.fn().mockResolvedValue(job),
      complete: vi.fn(),
      continue: vi.fn(),
      fail: vi.fn()
    };
    const processor = {
      process: vi
        .fn()
        .mockResolvedValueOnce({ output: { batch: 1 }, continueJob: true })
        .mockResolvedValueOnce({ output: { batch: 2 } })
    };

    await expect(processScheduledJobs(repository, processor, 3)).resolves.toBe(2);
    expect(repository.continue).toHaveBeenCalledTimes(1);
    expect(repository.complete).toHaveBeenCalledTimes(1);
    expect(repository.readyJobIds).toHaveBeenCalledWith(1);
  });
});
