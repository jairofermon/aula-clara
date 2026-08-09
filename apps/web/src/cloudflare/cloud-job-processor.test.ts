import { describe, expect, it, vi } from "vitest";
import type { ProcessingJob } from "./contracts";
import { createCloudJobProcessor } from "./cloud-job-processor";
import type { SupabaseJobRepository } from "./supabase-job-repository";

const job: ProcessingJob = {
  id: "00000000-0000-4000-8000-000000000001",
  class_id: "00000000-0000-4000-8000-000000000002",
  user_id: "00000000-0000-4000-8000-000000000003",
  job_type: "transcribe_chunk",
  status: "running",
  attempt_count: 2,
  max_attempts: 4,
  input_json: { chunk_id: "00000000-0000-4000-8000-000000000004" }
};

describe("processador gratuito", () => {
  it("não chama IA quando a transcrição já foi persistida", async () => {
    const run = vi.fn();
    const downloadAudio = vi.fn();
    const repository = {
      transcriptionInput: vi.fn().mockResolvedValue({
        chunk_id: "00000000-0000-4000-8000-000000000004",
        storage_path: "user/class/audio.mp3",
        size_bytes: 100,
        duration_ms: 1_000,
        language: "pt",
        context: "Aula",
        already_persisted: true
      }),
      downloadAudio,
      persistCloudTranscription: vi.fn().mockResolvedValue({
        segments: 0,
        chunks_completed: 1,
        chunks_total: 1,
        next_job_id: "00000000-0000-4000-8000-000000000005",
        resumed: true
      })
    } as unknown as SupabaseJobRepository;
    const env = {
      AI: { run },
      MAX_TRANSCRIPTION_CHUNK_MB: "15",
      CLOUDFLARE_TRANSCRIPTION_MODEL: "@cf/openai/whisper-large-v3-turbo"
    } as unknown as CloudflareEnv;
    const result = await createCloudJobProcessor(env, repository).process(job);
    expect(run).not.toHaveBeenCalled();
    expect(downloadAudio).not.toHaveBeenCalled();
    expect(result.nextJobIds).toEqual(["00000000-0000-4000-8000-000000000005"]);
    expect(result.output.resumed).toBe(true);
  });

  it("divide o lote quando a IA devolve resposta inconsistente", async () => {
    const firstId = "00000000-0000-4000-8000-000000000010";
    const secondId = "00000000-0000-4000-8000-000000000011";
    const reviewed = (index: number) => ({
      index,
      revised_text: "Texto revisado.",
      confidence: 0.95
    });
    const run = vi
      .fn()
      .mockResolvedValueOnce({ response: "resposta que não é JSON" })
      .mockResolvedValueOnce({ response: { segments: [reviewed(0)] } })
      .mockResolvedValueOnce({ response: { segments: [reviewed(0)] } });
    const applyReviewBatch = vi
      .fn()
      .mockResolvedValueOnce({ applied: 1, remaining: 1, needs_review: 0 })
      .mockResolvedValueOnce({ applied: 1, remaining: 0, needs_review: 0 });
    const repository = {
      reviewBatch: vi.fn().mockResolvedValue({
        context: "Aula de teste",
        segments: [
          { segment_id: firstId, raw_text: "Primeiro.", start_ms: 0, end_ms: 1000 },
          { segment_id: secondId, raw_text: "Segundo.", start_ms: 1000, end_ms: 2000 }
        ]
      }),
      applyReviewBatch
    } as unknown as SupabaseJobRepository;
    const env = {
      AI: { run, aiGatewayLogId: null },
      CLOUDFLARE_REVIEW_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
      MAX_TRANSCRIPTION_CHUNK_MB: "15"
    } as unknown as CloudflareEnv;
    const reviewJob = { ...job, job_type: "review_transcript" as const };

    const result = await createCloudJobProcessor(env, repository).process(reviewJob);

    expect(run).toHaveBeenCalledTimes(3);
    expect(repository.reviewBatch).toHaveBeenCalledWith(job.id, 24);
    expect(applyReviewBatch).toHaveBeenCalledTimes(2);
    expect(applyReviewBatch).toHaveBeenNthCalledWith(
      1,
      job.id,
      [expect.objectContaining({ segment_id: firstId })],
      expect.any(String),
      expect.any(Object)
    );
    expect(applyReviewBatch).toHaveBeenNthCalledWith(
      2,
      job.id,
      [expect.objectContaining({ segment_id: secondId })],
      expect.any(String),
      expect.any(Object)
    );
    expect(result.output).toMatchObject({ reviewed: 2, needs_review: 0 });
  });
});
