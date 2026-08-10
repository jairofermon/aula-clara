import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  applyGlobalReviewResultSchema,
  applyReviewResultSchema,
  assembleTranscriptResultSchema,
  assertTranscriptQuality,
  mergeTranscriptSegments,
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
import { assemblyAiEnabled, transcribeWithAssemblyAi } from "./assemblyai-provider";
import { deepgramEnabled, transcribeWithDeepgram } from "./deepgram-provider";
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
    audio_too_large: ["O áudio excede o limite máximo configurado para esta instalação.", false],
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

export function extractiveSummaryFallback(
  transcript: Array<{
    segment_id: string;
    start_ms: number;
    end_ms: number;
    speaker_label: string | null;
    text: string;
  }>
) {
  const sampleCount = Math.min(12, transcript.length);
  const sampled = Array.from({ length: sampleCount }, (_, index) => {
    const position =
      sampleCount === 1 ? 0 : Math.round((index * (transcript.length - 1)) / (sampleCount - 1));
    return transcript[position]!;
  });
  const excerpts = sampled.map((segment) => {
    const text = segment.text.replace(/\s+/gu, " ").trim();
    return text.length > 320 ? `${text.slice(0, 317).trim()}...` : text;
  });
  return {
    overview: excerpts.slice(0, 4).join(" "),
    concepts: excerpts,
    mechanisms: [],
    classifications: [],
    cause_and_effect: [],
    teacher_examples: [],
    emphasized_points: excerpts.slice(0, 8),
    traps: [],
    exam_items: excerpts.slice(0, 6),
    references: sampled.map((segment) => ({
      timestamp_ms: segment.start_ms,
      source_segment_ids: [segment.segment_id]
    }))
  };
}

function clockLabel(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

type MaterialTranscript = Parameters<typeof extractiveSummaryFallback>[0];

function transcriptSamples(transcript: MaterialTranscript, requested = 12) {
  const count = Math.min(requested, transcript.length);
  return Array.from({ length: count }, (_, index) => {
    const position = count === 1 ? 0 : Math.round((index * (transcript.length - 1)) / (count - 1));
    return transcript[position]!;
  });
}

function cleanExcerpt(text: string, maximum = 420): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  return clean.length > maximum ? `${clean.slice(0, maximum - 3).trim()}...` : clean;
}

export function fallbackStudyMaterial(
  materialType: Exclude<GeneratableMaterial, "summary">,
  transcript: MaterialTranscript,
  classTitle: string
): Record<string, unknown> {
  const sampled = transcriptSamples(transcript, Math.min(20, Math.max(10, transcript.length)));
  if (materialType === "notes") {
    const groupSize = Math.max(1, Math.ceil(transcript.length / 12));
    const sections = Array.from(
      { length: Math.ceil(transcript.length / groupSize) },
      (_, groupIndex) => {
        const group = transcript.slice(groupIndex * groupSize, (groupIndex + 1) * groupSize);
        const first = group[0]!;
        return {
          title: `Conteúdo a partir de ${clockLabel(first.start_ms)}`,
          body: group.map((segment) => cleanExcerpt(segment.text, 2000)).join(" "),
          timestamp_ms: first.start_ms,
          source_segment_ids: group.map((segment) => segment.segment_id)
        };
      }
    );
    return {
      title: `Apostila — ${classTitle}`,
      chronological_index: sections.map((section) => section.title),
      sections,
      teacher_examples: [],
      emphasized_points: sampled.slice(0, 8).map((segment) => cleanExcerpt(segment.text)),
      remaining_questions: []
    };
  }
  if (materialType === "flashcards") {
    return {
      flashcards: sampled.map((segment, index) => ({
        id: `fallback-card-${index + 1}`,
        front: `Explique o conteúdo apresentado por volta de ${clockLabel(segment.start_ms)}.`,
        back: cleanExcerpt(segment.text, 800),
        timestamp_ms: segment.start_ms,
        tags: ["revisão", "transcrição"],
        difficulty: (["medium", "hard", "easy"] as const)[index % 3],
        source_segment_ids: [segment.segment_id]
      }))
    };
  }
  if (materialType === "questions") {
    return {
      questions: sampled.map((segment, index) => {
        const alternatives = Array.from({ length: 5 }, (_, offset) => {
          const source = sampled[(index + offset) % sampled.length]!;
          return { id: `a${offset + 1}`, text: cleanExcerpt(source.text, 260) };
        });
        return {
          id: `fallback-question-${index + 1}`,
          question: `Qual alternativa corresponde ao conteúdo apresentado em ${clockLabel(segment.start_ms)}?`,
          alternatives,
          correct_alternative_id: "a1",
          correct_explanation: `A alternativa A reproduz o conteúdo associado ao timestamp ${clockLabel(segment.start_ms)}.`,
          incorrect_explanations: Object.fromEntries(
            alternatives
              .slice(1)
              .map((alternative) => [
                alternative.id,
                "Esse conteúdo pertence a outro momento da aula e não ao timestamp indicado."
              ])
          ),
          difficulty: (["medium", "hard", "medium"] as const)[index % 3],
          timestamp_ms: segment.start_ms,
          source_segment_ids: [segment.segment_id]
        };
      })
    };
  }
  const labels = sampled.map((segment, index) => ({
    id: `topic-${index + 1}`,
    label: `${clockLabel(segment.start_ms)} — ${cleanExcerpt(segment.text, 90)}`,
    children: []
  }));
  const mermaidLabels = labels.map((item) =>
    item.label
      .replace(/[^\p{L}\p{N}\s—-]/gu, "")
      .replace(/\s+/gu, " ")
      .trim()
  );
  return {
    title: `Mapa mental — ${classTitle}`,
    root: { id: "root", label: classTitle, children: labels },
    mermaid: ["mindmap", "  root((Aula))", ...mermaidLabels.map((label) => `    ${label}`)].join(
      "\n"
    )
  };
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
  private readonly maxSourceAudioBytes: number;
  private readonly maxInlineAudioBytes: number;

  constructor(
    private readonly env: CloudflareEnv,
    private readonly repository: SupabaseJobRepository
  ) {
    const maxSourceMegabytes = Number(env.MAX_AUDIO_UPLOAD_SIZE_MB || "50");
    const maxInlineMegabytes = Number(env.MAX_TRANSCRIPTION_CHUNK_MB);
    if (!Number.isFinite(maxSourceMegabytes) || maxSourceMegabytes <= 0)
      throw new Error("MAX_AUDIO_UPLOAD_SIZE_MB inválido");
    if (!Number.isFinite(maxInlineMegabytes) || maxInlineMegabytes <= 0)
      throw new Error("MAX_TRANSCRIPTION_CHUNK_MB inválido");
    this.maxSourceAudioBytes = Math.floor(maxSourceMegabytes * 1024 * 1024);
    this.maxInlineAudioBytes = Math.floor(maxInlineMegabytes * 1024 * 1024);
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
      await this.repository.prepareCloudAudio(job.id, this.maxSourceAudioBytes)
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
      if (input.size_bytes > this.maxSourceAudioBytes) rpcFailure("audio_too_large");
      let audio: ArrayBuffer | undefined;
      const bufferedAudio = async () => {
        if (!audio)
          audio = await this.repository.downloadAudio(input.storage_provider, input.storage_path);
        if (audio.byteLength === 0)
          throw new JobProcessingError("empty_audio", "O arquivo de áudio está vazio.", false);
        return audio;
      };

      const startedAt = Date.now();
      const accept = (response: unknown) => {
        const normalized = normalizeWhisperResponse(response, input.duration_ms);
        assertTranscriptQuality(normalized, input.duration_ms);
        return mergeTranscriptSegments(normalized);
      };
      let failure: JobProcessingError | undefined;
      const existingAssemblyTranscriptId =
        typeof job.output_json.assemblyai_transcript_id === "string"
          ? job.output_json.assemblyai_transcript_id
          : undefined;
      const skipPrimaryProvider = job.input_json.skip_primary_provider === true;
      if (
        input.size_bytes <= 24 * 1024 * 1024 &&
        !existingAssemblyTranscriptId &&
        !skipPrimaryProvider &&
        groqEnabled(this.env)
      ) {
        try {
          const filename = input.original_name;
          const result = await transcribeWithGroq(
            this.env,
            await bufferedAudio(),
            filename,
            input.language,
            input.context
          );
          segments = accept(result.data);
          providerModel = result.model;
          providerName = "groq";
        } catch (error) {
          failure = classifyAiError(error);
        }
      }
      if (!segments.length && assemblyAiEnabled(this.env)) {
        try {
          const source = existingAssemblyTranscriptId
            ? null
            : (await this.repository.openAudio(input.storage_provider, input.storage_path)).body;
          const result = await transcribeWithAssemblyAi(
            this.env,
            source,
            input.language,
            input.context,
            {
              existingTranscriptId: existingAssemblyTranscriptId,
              onSubmitted: async (transcriptId) => {
                await this.repository.saveProviderState(job.id, {
                  ...job.output_json,
                  assemblyai_transcript_id: transcriptId
                });
              }
            }
          );
          segments = accept(result.data);
          providerModel = result.model;
          providerName = "assemblyai";
        } catch (error) {
          const assemblyFailure = classifyAiError(error);
          failure = failure ? soonerRetry(failure, assemblyFailure) : assemblyFailure;
        }
      }
      if (!segments.length && deepgramEnabled(this.env)) {
        try {
          const source = (
            await this.repository.openAudio(input.storage_provider, input.storage_path)
          ).body;
          if (!source) throw new Error("audio_body_missing");
          const result = await transcribeWithDeepgram(
            this.env,
            source,
            input.original_name,
            input.language
          );
          segments = accept(result.data);
          providerModel = result.model;
          providerName = "deepgram";
        } catch (error) {
          const deepgramFailure = classifyAiError(error);
          failure = failure ? soonerRetry(failure, deepgramFailure) : deepgramFailure;
        }
      }
      if (!segments.length && input.size_bytes <= this.maxInlineAudioBytes) {
        try {
          const inlineAudio = await bufferedAudio();
          const response = await this.env.AI.run(this.env.CLOUDFLARE_TRANSCRIPTION_MODEL, {
            audio: Buffer.from(inlineAudio).toString("base64"),
            task: "transcribe",
            language: input.language,
            vad_filter: true,
            initial_prompt: input.context.slice(0, 1200) || undefined,
            condition_on_previous_text: true,
            no_speech_threshold: 0.6
          });
          segments = accept(response);
          providerModel = this.env.CLOUDFLARE_TRANSCRIPTION_MODEL;
          providerName = "cloudflare";
        } catch (error) {
          const cloudflareFailure = classifyAiError(error);
          failure = failure ? soonerRetry(failure, cloudflareFailure) : cloudflareFailure;
        }
      }
      if (
        !segments.length &&
        input.size_bytes <= this.maxInlineAudioBytes &&
        geminiEnabled(this.env)
      ) {
        try {
          const result = await transcribeWithGemini(
            this.env,
            await bufferedAudio(),
            input.original_name,
            input.language,
            input.context
          );
          segments = accept(result.data);
          providerModel = result.model;
          providerName = "gemini";
        } catch (error) {
          const geminiFailure = classifyAiError(error);
          failure = failure ? soonerRetry(failure, geminiFailure) : geminiFailure;
        }
      }
      if (!segments.length) {
        const nextRetrySeconds = Math.max(15, Math.min(failure?.retryDelaySeconds ?? 15, 60));
        throw new JobProcessingError(
          "all_transcription_providers_failed",
          "Todos os transcritores disponíveis foram consultados. O sistema continuará alternando automaticamente até concluir.",
          true,
          nextRetrySeconds
        );
      }
      providerDurationMs = Date.now() - startedAt;
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
          result.modelName ?? activeSegmentReviewModel(this.env),
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
      const preserveAndContinue =
        error instanceof JobProcessingError &&
        (error.code.startsWith("all_text_providers_failed:") ||
          [
            "review_segment_ids_mismatch",
            "invalid_provider_json",
            "invalid_provider_schema",
            "groq_request_too_large",
            "groq_invalid_request"
          ].includes(error.code));
      if (preserveAndContinue) {
        const preserved = applyReviewResultSchema.parse(
          await this.repository.applyReviewBatch(
            job.id,
            segments.map((segment) => ({
              segment_id: segment.segment_id,
              revised_text: segment.raw_text,
              confidence: 0.5
            })),
            "original-preserved-after-provider-failover",
            { durationMs: Date.now() - startedAt }
          )
        );
        if ("error_code" in preserved) rpcFailure(preserved.error_code);
        return preserved;
      }
      throw error;
    }
  }

  private async reviewTranscript(job: ProcessingJob) {
    if (job.input_json.phase === "global") return this.reviewWholeTranscript(job);
    let reviewed = 0;
    let needsReview = 0;
    for (let batchNumber = 0; batchNumber < 10; batchNumber += 1) {
      const input = reviewInputSchema.parse(await this.repository.reviewBatch(job.id, 16));
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
    let result: Awaited<ReturnType<typeof reviewWholeTranscriptWithWorkersAi>> | null = null;
    let model = activeGenerationModel(this.env);
    try {
      result = await reviewWholeTranscriptWithWorkersAi(this.env, input.segments, input.context);
    } catch (error) {
      if (!(error instanceof JobProcessingError)) throw error;
      // A revisão individual por IA já foi persistida em todos os segmentos.
      // A segunda leitura global é uma melhoria e nunca pode bloquear a entrega.
      model = "segment-review-validated";
    }
    const applied = applyGlobalReviewResultSchema.parse(
      await this.repository.applyGlobalReview(
        job.id,
        result?.data.patches.map((patch) => ({ ...patch })) ?? [],
        result?.data.checked_segments ?? input.segments.length,
        model,
        {
          durationMs: Date.now() - startedAt,
          inputUnits: result?.inputUnits,
          outputUnits: result?.outputUnits,
          requestId: result?.requestId
        }
      )
    );
    if ("error_code" in applied) rpcFailure(applied.error_code);
    return {
      output: {
        checked: applied.checked,
        patches_applied: applied.applied,
        global_review_fallback: result === null,
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
        generated.modelName ?? activeGenerationModel(this.env),
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
