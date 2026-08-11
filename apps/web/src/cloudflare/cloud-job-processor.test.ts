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
        storage_provider: "supabase",
        mime_type: "audio/mpeg",
        original_name: "audio.mp3",
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

  it("não persiste revisão quando a IA devolve resposta inconsistente", async () => {
    const firstId = "00000000-0000-4000-8000-000000000010";
    const secondId = "00000000-0000-4000-8000-000000000011";
    const run = vi.fn().mockResolvedValue({ response: "" });
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

    await expect(createCloudJobProcessor(env, repository).process(reviewJob)).rejects.toMatchObject(
      {
        code: expect.stringContaining("all_text_providers_failed:"),
        transient: true
      }
    );

    expect(run.mock.calls.length).toBeGreaterThan(1);
    expect(repository.reviewBatch).toHaveBeenCalledWith(job.id, 16);
    expect(applyReviewBatch).not.toHaveBeenCalled();
  });

  it("mantém o job para retry quando todos os provedores estão indisponíveis", async () => {
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

    await expect(
      createCloudJobProcessor(env, repository).process({
        ...job,
        job_type: "review_transcript"
      })
    ).rejects.toMatchObject({ transient: true });

    expect(applyReviewBatch).not.toHaveBeenCalled();
  });

  it("limita a revisão por execução e solicita continuação imediata", async () => {
    const segmentId = "00000000-0000-4000-8000-000000000010";
    const reviewBatch = vi.fn().mockResolvedValue({
      context: "Aula de teste",
      segments: [{ segment_id: segmentId, raw_text: "Trecho da aula.", start_ms: 0, end_ms: 1000 }]
    });
    const applyReviewBatch = vi
      .fn()
      .mockResolvedValueOnce({ applied: 1, remaining: 3, needs_review: 0 })
      .mockResolvedValueOnce({ applied: 1, remaining: 2, needs_review: 0 });
    const repository = { reviewBatch, applyReviewBatch } as unknown as SupabaseJobRepository;
    const env = {
      AI: {
        run: vi.fn().mockResolvedValue({
          response: {
            segments: [{ index: 0, revised_text: "Trecho da aula revisado.", confidence: 0.9 }]
          }
        })
      },
      CLOUDFLARE_REVIEW_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
      MAX_TRANSCRIPTION_CHUNK_MB: "15"
    } as unknown as CloudflareEnv;

    const result = await createCloudJobProcessor(env, repository).process({
      ...job,
      job_type: "review_transcript"
    });

    expect(reviewBatch).toHaveBeenCalledTimes(2);
    expect(applyReviewBatch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      output: { reviewed: 2, continuing: true },
      continueJob: true
    });
  });

  it("não valida a transcrição quando a revisão global falha", async () => {
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

    await expect(createCloudJobProcessor(env, repository).process(globalJob)).rejects.toMatchObject(
      {
        transient: true
      }
    );

    expect(applyGlobalReview).not.toHaveBeenCalled();
  });

  it("persiste uma parte do material por execução e retoma do checkpoint", async () => {
    const materialId = "00000000-0000-4000-8000-000000000030";
    const transcript = Array.from({ length: 2 }, (_, index) => ({
      segment_id: `00000000-0000-4000-8000-${(index + 60).toString().padStart(12, "0")}`,
      start_ms: index * 60_000,
      end_ms: (index + 1) * 60_000,
      speaker_label: null,
      text: `Explicação acadêmica detalhada da parte ${index + 1}. `.repeat(180)
    }));
    const run = vi.fn().mockImplementation(async (_model: string, request: unknown) => {
      const messages = (request as { messages: Array<{ content: string }> }).messages;
      const payload = JSON.parse(messages[1]!.content) as {
        transcript: Array<{ segment_id: string; start_ms: number }>;
      };
      const source = payload.transcript[0]!;
      const partNumber = run.mock.calls.length;
      return {
        response: {
          title: "Apostila retomável",
          chronological_index: [`Parte ${partNumber}`],
          sections: [
            {
              title: `Conceitos da parte ${partNumber}`,
              body: "Este capítulo explica os conceitos centrais de forma didática e relaciona definições, mecanismos, consequências e aplicações práticas. O conteúdo acadêmico é organizado em uma sequência coerente, sem repetições da fala, preservando os exemplos necessários para compreensão e revisão posterior. ".repeat(
                3
              ),
              timestamp_ms: source.start_ms,
              source_segment_ids: [source.segment_id]
            }
          ],
          teacher_examples: [],
          emphasized_points: [`Ênfase da parte ${partNumber}.`],
          remaining_questions: []
        }
      };
    });
    const saveProviderState = vi.fn().mockResolvedValue(undefined);
    const finishMaterial = vi.fn().mockResolvedValue({
      material_id: materialId,
      completed: true
    });
    const repository = {
      materialInput: vi.fn().mockResolvedValue({
        material_id: materialId,
        material_type: "notes",
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
      saveProviderState,
      finishMaterial
    } as unknown as SupabaseJobRepository;
    const env = {
      AI: { run, aiGatewayLogId: null },
      CLOUDFLARE_GENERATION_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
      MAX_TRANSCRIPTION_CHUNK_MB: "15"
    } as unknown as CloudflareEnv;
    const processor = createCloudJobProcessor(env, repository);
    const materialJob = { ...job, job_type: "generate_notes" as const, output_json: {} };

    const first = await processor.process(materialJob);

    expect(first.continueJob).toBe(true);
    expect(first.output).toMatchObject({ parts_completed: 1, parts_total: 2 });
    expect(saveProviderState).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(finishMaterial).not.toHaveBeenCalled();

    const second = await processor.process({
      ...materialJob,
      output_json: first.output
    });

    expect(second.continueJob).toBeUndefined();
    expect(second.output).toMatchObject({ material_id: materialId, resumed: false });
    expect(saveProviderState).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(finishMaterial).toHaveBeenCalledTimes(1);
    expect(finishMaterial).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        chronological_index: ["Conceitos da parte 1", "Conceitos da parte 2"]
      }),
      expect.any(String),
      expect.stringContaining("ai-composed"),
      expect.any(Object)
    );
  });

  it.each([
    ["summary", "generate_summary"],
    ["notes", "generate_notes"],
    ["flashcards", "generate_flashcards"],
    ["questions", "generate_questions"],
    ["mindmap", "generate_mindmap"]
  ] as const)("não marca %s como pronto sem geração válida por IA", async (type, jobType) => {
    const materialId = "00000000-0000-4000-8000-000000000030";
    const finishMaterial = vi.fn().mockResolvedValue({ material_id: materialId, completed: true });
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

    await expect(
      createCloudJobProcessor(env, repository).process({ ...job, job_type: jobType })
    ).rejects.toMatchObject({ transient: true });
    expect(finishMaterial).not.toHaveBeenCalled();
  });
});
