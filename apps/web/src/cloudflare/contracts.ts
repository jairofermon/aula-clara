import { z } from "zod";

export const processingQueueMessageSchema = z
  .object({
    job_id: z.uuid()
  })
  .strict();

export type ProcessingQueueMessage = z.infer<typeof processingQueueMessageSchema>;

export const processingJobSchema = z
  .object({
    id: z.uuid(),
    class_id: z.uuid(),
    user_id: z.uuid(),
    job_type: z.enum([
      "prepare_audio",
      "transcribe_chunk",
      "assemble_transcript",
      "review_transcript",
      "generate_notes",
      "generate_summary",
      "generate_flashcards",
      "generate_questions",
      "generate_mindmap",
      "generate_pdf"
    ]),
    status: z.enum(["pending", "running", "retry_wait", "completed", "failed", "cancelled"]),
    attempt_count: z.number().int().nonnegative(),
    max_attempts: z.number().int().positive(),
    input_json: z.record(z.string(), z.unknown()),
    output_json: z.record(z.string(), z.unknown()).default({})
  })
  .strip();

export type ProcessingJob = z.infer<typeof processingJobSchema>;

const whisperSegmentSchema = z
  .object({
    text: z.string().trim().min(1),
    start: z.number().nonnegative(),
    end: z.number().positive(),
    speaker: z.string().nullable().optional(),
    confidence: z.number().min(0).max(1).nullable().optional()
  })
  .strip()
  .refine((segment) => segment.end > segment.start, {
    message: "O fim do segmento deve ser posterior ao início"
  });

const whisperPayloadSchema = z
  .object({
    text: z.string().optional(),
    segments: z.array(whisperSegmentSchema).optional(),
    vtt: z.string().optional(),
    word_count: z.number().int().nonnegative().optional()
  })
  .strip();

export const whisperResponseSchema = whisperPayloadSchema.extend({
  transcription_info: z
    .object({
      language: z.string().optional(),
      language_probability: z.number().min(0).max(1).optional(),
      duration: z.number().nonnegative().optional(),
      duration_after_vad: z.number().nonnegative().optional()
    })
    .strip()
    .optional()
});

export interface CloudTranscriptSegment {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker_label: string | null;
  confidence: number | null;
}

const rpcErrorSchema = z.object({ error_code: z.string().min(1) }).strict();

export const prepareAudioResultSchema = z.union([
  rpcErrorSchema,
  z
    .object({
      chunk_id: z.uuid(),
      next_job_id: z.uuid(),
      duration_ms: z.number().int().positive(),
      resumed: z.boolean()
    })
    .strict()
]);

export const transcriptionInputSchema = z.union([
  rpcErrorSchema,
  z
    .object({
      chunk_id: z.uuid(),
      storage_path: z.string().min(1),
      storage_provider: z.enum(["supabase", "r2"]),
      mime_type: z.string().min(1),
      original_name: z.string().min(1),
      size_bytes: z.number().int().positive(),
      duration_ms: z.number().int().positive(),
      language: z.string().min(2).max(12),
      context: z.string(),
      already_persisted: z.boolean()
    })
    .strict()
]);

export const persistTranscriptionResultSchema = z.union([
  rpcErrorSchema,
  z
    .object({
      segments: z.number().int().nonnegative(),
      chunks_completed: z.number().int().nonnegative(),
      chunks_total: z.number().int().positive(),
      next_job_id: z.uuid().nullable(),
      resumed: z.boolean()
    })
    .strict()
]);

export const assembleTranscriptResultSchema = z.union([
  rpcErrorSchema,
  z
    .object({
      version: z.number().int().positive(),
      segments: z.number().int().positive(),
      next_job_id: z.uuid(),
      resumed: z.boolean()
    })
    .strict()
]);

export const reviewInputSegmentSchema = z
  .object({
    segment_id: z.uuid(),
    raw_text: z.string().min(1),
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().positive()
  })
  .strict();

export const reviewInputSchema = z.union([
  rpcErrorSchema,
  z
    .object({
      segments: z.array(reviewInputSegmentSchema),
      context: z.string()
    })
    .strict()
]);

export const applyReviewResultSchema = z.union([
  rpcErrorSchema,
  z
    .object({
      applied: z.number().int().positive(),
      remaining: z.number().int().nonnegative(),
      needs_review: z.number().int().nonnegative(),
      next_job_id: z.uuid().nullable().optional()
    })
    .strict()
]);

export const globalReviewInputSchema = z.union([
  rpcErrorSchema,
  z
    .object({
      segments: z.array(reviewInputSegmentSchema),
      context: z.string(),
      already_completed: z.boolean(),
      summary_job_id: z.uuid().nullable()
    })
    .strict()
]);

export const applyGlobalReviewResultSchema = z.union([
  rpcErrorSchema,
  z
    .object({
      applied: z.number().int().nonnegative(),
      checked: z.number().int().positive(),
      summary_job_id: z.uuid().nullable()
    })
    .strict()
]);

export const effectiveTranscriptSegmentSchema = z
  .object({
    segment_id: z.uuid(),
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().positive(),
    speaker_label: z.string().nullable(),
    text: z.string().min(1)
  })
  .strict();

const materialInputBaseSchema = z.object({
  material_id: z.uuid(),
  material_type: z.enum(["notes", "summary", "flashcards", "questions", "mindmap", "pdf"]),
  source_transcript_version: z.number().int().positive()
});

export const materialInputSchema = z.union([
  rpcErrorSchema,
  materialInputBaseSchema
    .extend({
      transcript: z.array(z.unknown()).max(0),
      class_context: z.object({}).strict(),
      already_completed: z.literal(true)
    })
    .strict(),
  materialInputBaseSchema
    .extend({
      transcript: z.array(effectiveTranscriptSegmentSchema).min(1),
      class_context: z
        .object({
          title: z.string().min(1),
          topic: z.string(),
          teacher_name: z.string().nullable(),
          class_date: z.string(),
          language: z.string().min(2),
          subject_name: z.string().min(1)
        })
        .strict(),
      already_completed: z.literal(false)
    })
    .strict()
]);

export const finishMaterialResultSchema = z.union([
  rpcErrorSchema,
  z.object({ material_id: z.uuid(), completed: z.literal(true) }).strict()
]);

export const workersAiJsonResponseSchema = z
  .object({
    response: z.unknown(),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional()
      })
      .strip()
      .optional()
  })
  .strip();

export function normalizeWhisperResponse(
  value: unknown,
  durationMs: number
): CloudTranscriptSegment[] {
  const parsed = whisperResponseSchema.parse(value);
  if (parsed.segments?.length) {
    return parsed.segments
      .map((segment) => ({
        text: segment.text,
        start_ms: Math.max(0, Math.round(segment.start * 1000)),
        end_ms: Math.min(durationMs, Math.round(segment.end * 1000)),
        speaker_label: segment.speaker ?? null,
        confidence: segment.confidence ?? null
      }))
      .filter((segment) => segment.start_ms < durationMs && segment.end_ms > segment.start_ms);
  }
  const text = parsed.text?.trim();
  return text
    ? [{ text, start_ms: 0, end_ms: durationMs, speaker_label: null, confidence: null }]
    : [];
}

function normalizedSpeech(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export function mergeTranscriptSegments(
  segments: ReadonlyArray<CloudTranscriptSegment>,
  targetDurationMs = 20_000,
  maximumCharacters = 1_000
): CloudTranscriptSegment[] {
  const merged: CloudTranscriptSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    const sameSpeaker = (previous?.speaker_label ?? null) === (segment.speaker_label ?? null);
    const closeInTime = previous ? segment.start_ms - previous.end_ms <= 2_000 : false;
    const withinTarget = previous ? segment.end_ms - previous.start_ms <= targetDurationMs : false;
    const withinTextLimit = previous
      ? previous.text.length + segment.text.length + 1 <= maximumCharacters
      : false;
    if (previous && sameSpeaker && closeInTime && withinTarget && withinTextLimit) {
      previous.text = `${previous.text.trim()} ${segment.text.trim()}`.trim();
      previous.end_ms = Math.max(previous.end_ms, segment.end_ms);
      const confidences = [previous.confidence, segment.confidence].filter(
        (value): value is number => value !== null
      );
      previous.confidence = confidences.length
        ? Math.round(
            (confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 10_000
          ) / 10_000
        : null;
    } else {
      merged.push({ ...segment, text: segment.text.trim() });
    }
  }
  return merged;
}

export function assertTranscriptQuality(
  segments: ReadonlyArray<CloudTranscriptSegment>,
  durationMs: number
): void {
  if (!segments.length)
    throw new JobProcessingError("no_speech", "Nenhuma fala foi identificada.", false);
  const durationMinutes = Math.max(1, durationMs / 60_000);
  const charactersPerMinute =
    segments.reduce((total, segment) => total + segment.text.trim().length, 0) / durationMinutes;
  const coverage = Math.max(...segments.map((segment) => segment.end_ms)) / durationMs;
  let repeatedRun = 1;
  let maximumRepeatedRun = 1;
  let previous = "";
  for (const segment of segments) {
    const current = normalizedSpeech(segment.text);
    repeatedRun = current.length >= 25 && current === previous ? repeatedRun + 1 : 1;
    maximumRepeatedRun = Math.max(maximumRepeatedRun, repeatedRun);
    previous = current;
  }
  if (
    (durationMs >= 10 * 60_000 && charactersPerMinute < 100) ||
    (durationMs >= 10 * 60_000 && coverage < 0.75) ||
    maximumRepeatedRun >= 3
  ) {
    throw new JobProcessingError(
      "transcription_quality_insufficient",
      "A transcrição ficou incompleta ou repetitiva. O próximo provedor será tentado.",
      true,
      1
    );
  }
}

export class JobProcessingError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly transient: boolean,
    readonly retryDelaySeconds?: number
  ) {
    super(publicMessage);
    this.name = "JobProcessingError";
  }
}
