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
});
