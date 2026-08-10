import { describe, expect, it, vi } from "vitest";
import {
  flashcardsContentSchema,
  mindmapContentSchema,
  notesContentSchema,
  questionsContentSchema
} from "@aula-clara/shared";
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
  input_json: { chunk_id: "00000000-0000-4000-8000-000000000004" },
  output_json: {}
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

  it("preserva e conclui o lote quando a IA devolve resposta inconsistente", async () => {
    const firstId = "00000000-0000-4000-8000-000000000010";
    const secondId = "00000000-0000-4000-8000-000000000011";
    const run = vi.fn().mockResolvedValue({ response: "resposta que não é JSON" });
    const applyReviewBatch = vi
      .fn()
      .mockResolvedValue({ applied: 2, remaining: 0, needs_review: 0 });
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

    expect(run).toHaveBeenCalledTimes(1);
    expect(repository.reviewBatch).toHaveBeenCalledWith(job.id, 16);
    expect(applyReviewBatch).toHaveBeenCalledTimes(1);
    expect(applyReviewBatch).toHaveBeenCalledWith(
      job.id,
      [
        expect.objectContaining({ segment_id: firstId, revised_text: "Primeiro." }),
        expect.objectContaining({ segment_id: secondId, revised_text: "Segundo." })
      ],
      "original-preserved-after-provider-failover",
      expect.any(Object)
    );
    expect(result.output).toMatchObject({ reviewed: 2, needs_review: 0 });
  });

  it("persiste o lote preservado quando todos os provedores estão indisponíveis", async () => {
    const firstId = "00000000-0000-4000-8000-000000000010";
    const secondId = "00000000-0000-4000-8000-000000000011";
    const applyReviewBatch = vi.fn().mockResolvedValue({
      applied: 2,
      remaining: 0,
      needs_review: 0,
      next_job_id: "00000000-0000-4000-8000-000000000012"
    });
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
      AI: {
        run: vi.fn().mockRejectedValue(new Error("3036 daily free allocation")),
        aiGatewayLogId: null
      },
      CLOUDFLARE_REVIEW_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
      MAX_TRANSCRIPTION_CHUNK_MB: "15"
    } as unknown as CloudflareEnv;

    const result = await createCloudJobProcessor(env, repository).process({
      ...job,
      job_type: "review_transcript"
    });

    expect(applyReviewBatch).toHaveBeenCalledWith(
      job.id,
      [
        expect.objectContaining({ segment_id: firstId, revised_text: "Primeiro." }),
        expect.objectContaining({ segment_id: secondId, revised_text: "Segundo." })
      ],
      "original-preserved-after-provider-failover",
      expect.any(Object)
    );
    expect(result.output).toMatchObject({ reviewed: 2, needs_review: 0 });
    expect(result.nextJobIds).toEqual(["00000000-0000-4000-8000-000000000012"]);
  });

  it("não bloqueia a entrega quando todos os provedores falham na segunda revisão", async () => {
    const summaryJobId = "00000000-0000-4000-8000-000000000020";
    const applyGlobalReview = vi.fn().mockResolvedValue({
      applied: 0,
      checked: 1,
      summary_job_id: summaryJobId
    });
    const repository = {
      globalReviewInput: vi.fn().mockResolvedValue({
        context: "Aula de teste",
        already_completed: false,
        summary_job_id: null,
        segments: [
          {
            segment_id: "00000000-0000-4000-8000-000000000010",
            raw_text: "Texto já revisado por segmento.",
            start_ms: 0,
            end_ms: 1000
          }
        ]
      }),
      applyGlobalReview
    } as unknown as SupabaseJobRepository;
    const env = {
      AI: { run: vi.fn().mockResolvedValue({ response: "JSON inválido" }), aiGatewayLogId: null },
      CLOUDFLARE_GENERATION_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
      CLOUDFLARE_REVIEW_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
      MAX_TRANSCRIPTION_CHUNK_MB: "15"
    } as unknown as CloudflareEnv;
    const globalJob = {
      ...job,
      job_type: "review_transcript" as const,
      input_json: { phase: "global" }
    };

    const result = await createCloudJobProcessor(env, repository).process(globalJob);

    expect(applyGlobalReview).toHaveBeenCalledWith(
      job.id,
      [],
      1,
      "segment-review-validated",
      expect.any(Object)
    );
    expect(result.output).toMatchObject({
      checked: 1,
      patches_applied: 0,
      global_review_fallback: true,
      transcript_validated: true
    });
    expect(result.nextJobIds).toEqual([summaryJobId]);
  });

  it("conclui o resumo com extração da transcrição quando todo o ranking falha", async () => {
    const materialId = "00000000-0000-4000-8000-000000000030";
    const finishMaterial = vi.fn().mockResolvedValue({ material_id: materialId, completed: true });
    const repository = {
      materialInput: vi.fn().mockResolvedValue({
        material_id: materialId,
        material_type: "summary",
        source_transcript_version: 3,
        already_completed: false,
        class_context: {
          title: "Aula de teste",
          topic: "Tema",
          teacher_name: null,
          class_date: "2026-08-09",
          language: "pt",
          subject_name: "Disciplina"
        },
        transcript: [
          {
            segment_id: "00000000-0000-4000-8000-000000000010",
            start_ms: 0,
            end_ms: 1000,
            speaker_label: null,
            text: "Explicação inicial completa da aula."
          },
          {
            segment_id: "00000000-0000-4000-8000-000000000011",
            start_ms: 1000,
            end_ms: 2000,
            speaker_label: null,
            text: "Conclusão e pontos importantes da aula."
          }
        ]
      }),
      finishMaterial
    } as unknown as SupabaseJobRepository;
    const env = {
      AI: { run: vi.fn().mockResolvedValue({ response: "inválido" }), aiGatewayLogId: null },
      CLOUDFLARE_GENERATION_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
      MAX_TRANSCRIPTION_CHUNK_MB: "15"
    } as unknown as CloudflareEnv;

    const result = await createCloudJobProcessor(env, repository).process({
      ...job,
      job_type: "generate_summary"
    });

    expect(finishMaterial).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        overview: expect.stringContaining("Explicação inicial"),
        references: expect.arrayContaining([expect.objectContaining({ timestamp_ms: 0 })])
      }),
      expect.any(String),
      "extractive-summary-after-provider-failover",
      expect.any(Object)
    );
    expect(result.output).toMatchObject({ material_id: materialId, material_type: "summary" });
  });

  it.each([
    ["notes", "generate_notes", notesContentSchema],
    ["flashcards", "generate_flashcards", flashcardsContentSchema],
    ["questions", "generate_questions", questionsContentSchema],
    ["mindmap", "generate_mindmap", mindmapContentSchema]
  ] as const)(
    "conclui %s com fallback validado quando todo o ranking falha",
    async (type, jobType, schema) => {
      const materialId = "00000000-0000-4000-8000-000000000030";
      const finishMaterial = vi
        .fn()
        .mockResolvedValue({ material_id: materialId, completed: true });
      const transcript = Array.from({ length: 12 }, (_, index) => ({
        segment_id: `00000000-0000-4000-8000-${(index + 10).toString().padStart(12, "0")}`,
        start_ms: index * 60_000,
        end_ms: (index + 1) * 60_000,
        speaker_label: null,
        text: `Conteúdo completo e específico do tópico ${index + 1}, com explicação suficiente para estudo.`
      }));
      const repository = {
        materialInput: vi.fn().mockResolvedValue({
          material_id: materialId,
          material_type: type,
          source_transcript_version: 3,
          already_completed: false,
          class_context: {
            title: "Aula de teste",
            topic: "Tema",
            teacher_name: null,
            class_date: "2026-08-09",
            language: "pt",
            subject_name: "Disciplina"
          },
          transcript
        }),
        finishMaterial
      } as unknown as SupabaseJobRepository;
      const env = {
        AI: { run: vi.fn().mockResolvedValue({ response: "inválido" }), aiGatewayLogId: null },
        CLOUDFLARE_GENERATION_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
        MAX_TRANSCRIPTION_CHUNK_MB: "15"
      } as unknown as CloudflareEnv;

      const result = await createCloudJobProcessor(env, repository).process({
        ...job,
        job_type: jobType
      });

      const structuredContent = finishMaterial.mock.calls[0]?.[1];
      expect(schema.parse(structuredContent)).toEqual(structuredContent);
      expect(finishMaterial.mock.calls[0]?.[3]).toBe(`extractive-${type}-after-provider-failover`);
      expect(result.output).toMatchObject({ material_id: materialId, material_type: type });
    }
  );
});
