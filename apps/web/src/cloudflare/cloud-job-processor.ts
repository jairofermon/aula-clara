import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  applyGlobalReviewResultSchema,
  applyReviewResultSchema,
  assembleTranscriptResultSchema,
  finishMaterialResultSchema,
  globalReviewInputSchema,
  JobProcessingError,
  materialInputSchema,
  normalizeWhisperResponse,
  persistTranscriptionResultSchema,
  prepareAudioResultSchema,
  reviewInputSchema,
  transcriptionInputSchema,
  type ProcessingJob
} from "./contracts";
import type { CloudJobProcessor } from "./queue-consumer";
import type { SupabaseJobRepository } from "./supabase-job-repository";
import {
  activeGenerationModel,
  activeSegmentReviewModel,
  groqEnabled,
  transcribeWithGroq
} from "./groq-provider";
import { geminiEnabled, transcribeWithGemini } from "./gemini-provider";
import {
  generateWithWorkersAi,
  markdownForMaterial,
  reviewWholeTranscriptWithWorkersAi,
  reviewWithWorkersAi,
  type GeneratableMaterial
} from "./workers-ai-content";

function nextFreeQuotaWindowSeconds(): number {
  const now = new Date();
  const nextMidnightUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    1
  );
  return Math.max(60, Math.ceil((nextMidnightUtc - now.getTime()) / 1000));
}

function rpcFailure(errorCode: string): never {
  const failures: Record<string, [string, boolean]> = {
    audio_missing: ["O arquivo de áudio não foi encontrado.", false],
    invalid_source_file: ["A referência do áudio é inválida.", false],
    duration_missing: ["Não foi possível identificar a duração do áudio.", false],
    audio_too_large: ["O áudio excede o limite de 15 MB da edição gratuita inicial.", false],
    invalid_chunk: ["O bloco de áudio é inválido.", false],
    chunk_missing: ["O bloco de áudio não foi encontrado.", false],
    no_speech: ["Nenhuma fala foi identificada no áudio.", false],
    invalid_review_response: ["A revisão retornou um formato inválido.", true],
    review_segment_conflict: ["A revisão foi atualizada em outra execução e será retomada.", true],
    invalid_material: ["A referência do material é inválida.", false],
    material_missing: ["O material solicitado não foi encontrado.", false],
    review_required: ["A correção automática ainda está sendo concluída.", true],
    transcript_missing: ["A transcrição validada não foi encontrada.", false],
    job_not_claimed: ["O job perdeu o lock e será recuperado com segurança.", true]
  };
  const [message, transient] = failures[errorCode] ?? [
    "A etapa retornou um resultado inválido e será tentada novamente.",
    true
  ];
  throw new JobProcessingError(errorCode, message, transient);
}

type ReviewSegmentInput = {
  segment_id: string;
  raw_text: string;
  start_ms: number;
  end_ms: number;
};

function classifyAiError(error: unknown): JobProcessingError {
  if (error instanceof JobProcessingError) return error;
  const details = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : "";
  if (details.includes("3036") || details.includes("daily free allocation")) {
    return new JobProcessingError(
      "cloudflare_daily_quota",
      "A cota gratuita diária de inteligência artificial foi atingida. O processamento será retomado após a renovação.",
      true,
      nextFreeQuotaWindowSeconds()
    );
  }
  if (details.includes("3006") || details.includes("request too large")) {
    return new JobProcessingError(
      "provider_file_too_large",
      "O bloco de áudio excede o limite aceito pelo transcritor.",
      false
    );
  }
  if (details.includes("401") || details.includes("403") || details.includes("not allowed")) {
    return new JobProcessingError(
      "provider_not_authorized",
      "O serviço gratuito de transcrição não está autorizado nesta conta.",
      false
    );
  }
  return new JobProcessingError(
    "cloudflare_ai_unavailable",
    "O serviço de transcrição está temporariamente indisponível.",
    true
  );
}

function soonerRetry(first: JobProcessingError, second: JobProcessingError): JobProcessingError {
  if (!first.transient) return second;
  if (!second.transient) return first;
  return (first.retryDelaySeconds ?? 3600) <= (second.retryDelaySeconds ?? 3600) ? first : second;
}

const sourceJobInputSchema = z.object({ source_file_id: z.uuid() }).passthrough();
const chunkJobInputSchema = z.object({ chunk_id: z.uuid() }).passthrough();

class WorkersAiJobProcessor implements CloudJobProcessor {
  private readonly maxAudioBytes: number;

  constructor(
    private readonly env: CloudflareEnv,
    private readonly repository: SupabaseJobRepository
  ) {
    const maxMegabytes = Number(env.MAX_TRANSCRIPTION_CHUNK_MB);
    if (!Number.isFinite(maxMegabytes) || maxMegabytes <= 0)
      throw new Error("MAX_TRANSCRIPTION_CHUNK_MB inválido");
    this.maxAudioBytes = Math.floor(maxMegabytes * 1024 * 1024);
  }

  async process(job: ProcessingJob) {
    switch (job.job_type) {
      case "prepare_audio":
        return this.prepareAudio(job);
      case "transcribe_chunk":
        return this.transcribeChunk(job);
      case "assemble_transcript":
        return this.assembleTranscript(job);
      case "review_transcript":
        return this.reviewTranscript(job);
      case "generate_notes":
        return this.generateMaterial(job, "notes");
      case "generate_summary":
        return this.generateMaterial(job, "summary");
      case "generate_flashcards":
        return this.generateMaterial(job, "flashcards");
      case "generate_questions":
        return this.generateMaterial(job, "questions");
      case "generate_mindmap":
        return this.generateMaterial(job, "mindmap");
      case "generate_pdf":
        throw new JobProcessingError(
          "browser_pdf_required",
          "Na edição gratuita, o PDF deve ser gerado pelo navegador.",
          false
        );
      default:
        throw new JobProcessingError(
          "cloud_stage_not_implemented",
          `A etapa ${job.job_type} ainda não está habilitada na edição gratuita.`,
          false
        );
    }
  }

  private async prepareAudio(job: ProcessingJob) {
    sourceJobInputSchema.parse(job.input_json);
    const parsed = prepareAudioResultSchema.parse(
      await this.repository.prepareCloudAudio(job.id, this.maxAudioBytes)
    );
    if ("error_code" in parsed) rpcFailure(parsed.error_code);
    return {
      output: {
        chunk_count: 1,
        duration_ms: parsed.duration_ms,
        resumed: parsed.resumed
      },
      nextJobIds: [parsed.next_job_id]
    };
  }

  private async transcribeChunk(job: ProcessingJob) {
    chunkJobInputSchema.parse(job.input_json);
    const input = transcriptionInputSchema.parse(await this.repository.transcriptionInput(job.id));
    if ("error_code" in input) rpcFailure(input.error_code);

    let segments: ReturnType<typeof normalizeWhisperResponse> = [];
    let providerDurationMs = 0;
    let providerModel: string = this.env.CLOUDFLARE_TRANSCRIPTION_MODEL;
    let providerName = "cloudflare";
    if (!input.already_persisted) {
      if (input.size_bytes > this.maxAudioBytes) rpcFailure("audio_too_large");
      const audio = await this.repository.downloadAudio(input.storage_path);
      if (audio.byteLength === 0)
        throw new JobProcessingError("empty_audio", "O arquivo de áudio está vazio.", false);
      if (audio.byteLength > this.maxAudioBytes) rpcFailure("audio_too_large");

      const startedAt = Date.now();
      let response: unknown;
      let failure: JobProcessingError | undefined;
      if (groqEnabled(this.env)) {
        try {
          const filename = input.storage_path.split("/").at(-1) ?? "audio.mp3";
          const result = await transcribeWithGroq(
            this.env,
            audio,
            filename,
            input.language,
            input.context
          );
          response = result.data;
          providerModel = result.model;
          providerName = "groq";
        } catch (error) {
          failure = classifyAiError(error);
        }
      }
      if (response === undefined) {
        try {
          response = await this.env.AI.run(this.env.CLOUDFLARE_TRANSCRIPTION_MODEL, {
            audio: Buffer.from(audio).toString("base64"),
            task: "transcribe",
            language: input.language,
            vad_filter: true,
            initial_prompt: input.context.slice(0, 1200) || undefined,
            condition_on_previous_text: true,
            no_speech_threshold: 0.6
          });
          providerModel = this.env.CLOUDFLARE_TRANSCRIPTION_MODEL;
          providerName = "cloudflare";
        } catch (error) {
          const cloudflareFailure = classifyAiError(error);
          failure = failure ? soonerRetry(failure, cloudflareFailure) : cloudflareFailure;
        }
      }
      if (response === undefined && geminiEnabled(this.env)) {
        try {
          const filename = input.storage_path.split("/").at(-1) ?? "audio.mp3";
          const result = await transcribeWithGemini(
            this.env,
            audio,
            filename,
            input.language,
            input.context
          );
          response = result.data;
          providerModel = result.model;
          providerName = "gemini";
        } catch (error) {
          const geminiFailure = classifyAiError(error);
          failure = failure ? soonerRetry(failure, geminiFailure) : geminiFailure;
        }
      }
      if (response === undefined) throw failure ?? classifyAiError(new Error("no provider"));
      providerDurationMs = Date.now() - startedAt;
      segments = normalizeWhisperResponse(response, input.duration_ms);
      if (!segments.length) rpcFailure("no_speech");
    }

    const persisted = persistTranscriptionResultSchema.parse(
      await this.repository.persistCloudTranscription(
        job.id,
        segments.map((segment) => ({ ...segment })),
        providerModel,
        providerDurationMs,
        providerName
      )
    );
    if ("error_code" in persisted) rpcFailure(persisted.error_code);
    return {
      output: {
        chunk_id: input.chunk_id,
        segments: persisted.segments,
        chunks_completed: persisted.chunks_completed,
        chunks_total: persisted.chunks_total,
        resumed: input.already_persisted || persisted.resumed
      },
      nextJobIds: persisted.next_job_id ? [persisted.next_job_id] : []
    };
  }

  private async assembleTranscript(job: ProcessingJob) {
    const parsed = assembleTranscriptResultSchema.parse(
      await this.repository.assembleCloudTranscript(job.id)
    );
    if ("error_code" in parsed) rpcFailure(parsed.error_code);
    return {
      output: {
        version: parsed.version,
        segments: parsed.segments,
        resumed: parsed.resumed
      },
      nextJobIds: [parsed.next_job_id]
    };
  }

  private async applyReviewSegments(
    job: ProcessingJob,
    segments: ReviewSegmentInput[],
    context: string
  ): Promise<{
    applied: number;
    remaining: number;
    needs_review: number;
    next_job_id?: string | null;
  }> {
    const startedAt = Date.now();
    try {
      const result = await reviewWithWorkersAi(
        this.env,
        segments,
        context,
        activeSegmentReviewModel(this.env)
      );
      const applied = applyReviewResultSchema.parse(
        await this.repository.applyReviewBatch(
          job.id,
          result.data.segments.map((segment) => ({ ...segment })),
          activeSegmentReviewModel(this.env),
          {
            durationMs: Date.now() - startedAt,
            inputUnits: result.inputUnits,
            outputUnits: result.outputUnits,
            requestId: result.requestId
          }
        )
      );
      if ("error_code" in applied) rpcFailure(applied.error_code);
      return applied;
    } catch (error) {
      const canSplit =
        error instanceof JobProcessingError &&
        [
          "review_segment_ids_mismatch",
          "invalid_provider_json",
          "invalid_provider_schema",
          "groq_request_too_large",
          "groq_invalid_request"
        ].includes(error.code);
      if (!canSplit || segments.length === 1) {
        throw error;
      }
      const middle = Math.ceil(segments.length / 2);
      const first = await this.applyReviewSegments(job, segments.slice(0, middle), context);
      const second = await this.applyReviewSegments(job, segments.slice(middle), context);
      return {
        applied: first.applied + second.applied,
        remaining: second.remaining,
        needs_review: second.needs_review,
        next_job_id: second.next_job_id
      };
    }
  }

  private async reviewTranscript(job: ProcessingJob) {
    if (job.input_json.phase === "global") return this.reviewWholeTranscript(job);
    let reviewed = 0;
    let needsReview = 0;
    for (let batchNumber = 0; batchNumber < 10; batchNumber += 1) {
      const input = reviewInputSchema.parse(
        await this.repository.reviewBatch(job.id, groqEnabled(this.env) ? 4 : 24)
      );
      if ("error_code" in input) rpcFailure(input.error_code);
      if (!input.segments.length) {
        return { output: { reviewed, needs_review: needsReview, resumed: reviewed === 0 } };
      }

      const applied = await this.applyReviewSegments(job, input.segments, input.context);
      reviewed += applied.applied;
      needsReview = applied.needs_review;
      if (applied.remaining === 0) {
        return {
          output: { reviewed, needs_review: needsReview, resumed: false },
          nextJobIds: applied.next_job_id ? [applied.next_job_id] : []
        };
      }
    }
    return {
      output: { reviewed, needs_review: needsReview, resumed: false, continuing: true },
      continueJob: true
    };
  }

  private async reviewWholeTranscript(job: ProcessingJob) {
    const input = globalReviewInputSchema.parse(await this.repository.globalReviewInput(job.id));
    if ("error_code" in input) rpcFailure(input.error_code);
    if (input.already_completed) {
      return {
        output: { resumed: true, transcript_validated: true, study_ready: false },
        nextJobIds: input.summary_job_id ? [input.summary_job_id] : []
      };
    }
    const startedAt = Date.now();
    const result = await reviewWholeTranscriptWithWorkersAi(
      this.env,
      input.segments,
      input.context
    );
    const model = activeGenerationModel(this.env);
    const applied = applyGlobalReviewResultSchema.parse(
      await this.repository.applyGlobalReview(
        job.id,
        result.data.patches.map((patch) => ({ ...patch })),
        result.data.checked_segments,
        model,
        {
          durationMs: Date.now() - startedAt,
          inputUnits: result.inputUnits,
          outputUnits: result.outputUnits,
          requestId: result.requestId
        }
      )
    );
    if ("error_code" in applied) rpcFailure(applied.error_code);
    return {
      output: {
        checked: applied.checked,
        patches_applied: applied.applied,
        transcript_validated: true,
        study_ready: false
      },
      nextJobIds: applied.summary_job_id ? [applied.summary_job_id] : []
    };
  }

  private async generateMaterial(job: ProcessingJob, materialType: GeneratableMaterial) {
    const input = materialInputSchema.parse(await this.repository.materialInput(job.id));
    if ("error_code" in input) rpcFailure(input.error_code);
    if (input.already_completed) {
      return {
        output: { material_id: input.material_id, material_type: materialType, resumed: true }
      };
    }
    if (input.material_type !== materialType) rpcFailure("invalid_material");

    const startedAt = Date.now();
    const generated = await generateWithWorkersAi(
      this.env,
      materialType,
      input.transcript,
      input.class_context
    );
    const structuredContent = generated.data as Record<string, unknown>;
    const finished = finishMaterialResultSchema.parse(
      await this.repository.finishMaterial(
        job.id,
        structuredContent,
        markdownForMaterial(materialType, structuredContent),
        activeGenerationModel(this.env),
        {
          durationMs: Date.now() - startedAt,
          inputUnits: generated.inputUnits,
          outputUnits: generated.outputUnits,
          requestId: generated.requestId
        }
      )
    );
    if ("error_code" in finished) rpcFailure(finished.error_code);
    return {
      output: { material_id: finished.material_id, material_type: materialType, resumed: false }
    };
  }
}

export function createCloudJobProcessor(
  env: CloudflareEnv,
  repository: SupabaseJobRepository
): CloudJobProcessor {
  return new WorkersAiJobProcessor(env, repository);
}
