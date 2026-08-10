import { z } from "zod";
import { JobProcessingError } from "./contracts";

const uploadResponseSchema = z.object({ upload_url: z.url() }).strip();
const submitResponseSchema = z.object({ id: z.string().min(1) }).passthrough();

const timedTextSchema = z
  .object({
    text: z.string().trim().min(1),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    speaker: z.string().nullable().optional()
  })
  .passthrough()
  .refine((item) => item.end > item.start);

const transcriptResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["queued", "processing", "completed", "error"]),
    error: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    utterances: z.array(timedTextSchema).nullable().optional(),
    words: z.array(timedTextSchema).nullable().optional()
  })
  .passthrough();

type TimedText = z.infer<typeof timedTextSchema>;

export interface AssemblyAiOptions {
  existingTranscriptId?: string;
  onSubmitted?: (transcriptId: string) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

function retryDelay(response: Response): number {
  const raw = response.headers.get("retry-after");
  const seconds = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) ? Math.max(5, Math.min(Math.ceil(seconds), 86_400)) : 60;
}

async function assemblyAiError(response: Response): Promise<never> {
  if (response.status === 429) {
    throw new JobProcessingError(
      "assemblyai_rate_limit",
      "A capacidade do transcritor alternativo está ocupada.",
      true,
      retryDelay(response)
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new JobProcessingError(
      "assemblyai_not_authorized",
      "A integração do transcritor alternativo precisa ser reconectada.",
      false
    );
  }
  if (response.status === 402) {
    throw new JobProcessingError(
      "assemblyai_quota_exhausted",
      "Os créditos do transcritor alternativo terminaram.",
      false
    );
  }
  if (response.status >= 500) {
    throw new JobProcessingError(
      "assemblyai_unavailable",
      "O transcritor alternativo está temporariamente indisponível.",
      true,
      60
    );
  }
  throw new JobProcessingError(
    "assemblyai_invalid_request",
    "O transcritor alternativo recusou este áudio.",
    false
  );
}

async function assemblyFetch(
  env: CloudflareEnv,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const response = await fetch(`https://api.assemblyai.com${path}`, {
    ...init,
    headers: {
      authorization: env.ASSEMBLYAI_API_KEY,
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) await assemblyAiError(response);
  return response;
}

export function assemblyAiEnabled(env: CloudflareEnv): boolean {
  return typeof env.ASSEMBLYAI_API_KEY === "string" && env.ASSEMBLYAI_API_KEY.length > 10;
}

function splitWords(words: TimedText[]): TimedText[] {
  const segments: TimedText[] = [];
  let current: TimedText[] = [];
  for (const word of words) {
    current.push(word);
    const elapsed = word.end - current[0]!.start;
    if (/[.!?…]$/.test(word.text) || elapsed >= 12_000 || current.length >= 35) {
      segments.push({
        text: current.map((item) => item.text).join(" "),
        start: current[0]!.start,
        end: word.end,
        confidence: current.reduce((sum, item) => sum + (item.confidence ?? 0), 0) / current.length,
        speaker: current[0]!.speaker ?? null
      });
      current = [];
    }
  }
  if (current.length) {
    segments.push({
      text: current.map((item) => item.text).join(" "),
      start: current[0]!.start,
      end: current.at(-1)!.end,
      confidence: current.reduce((sum, item) => sum + (item.confidence ?? 0), 0) / current.length,
      speaker: current[0]!.speaker ?? null
    });
  }
  return segments;
}

function normalizedSegments(transcript: z.infer<typeof transcriptResponseSchema>) {
  const source = transcript.utterances?.length
    ? transcript.utterances
    : transcript.words?.length
      ? splitWords(transcript.words)
      : [];
  return source.map((segment) => ({
    text: segment.text,
    start: segment.start / 1000,
    end: segment.end / 1000,
    speaker: segment.speaker ?? null,
    confidence: segment.confidence ?? null
  }));
}

export async function transcribeWithAssemblyAi(
  env: CloudflareEnv,
  audio: BodyInit | null,
  language: string,
  context: string,
  options: AssemblyAiOptions = {}
) {
  if (!assemblyAiEnabled(env)) {
    throw new JobProcessingError(
      "assemblyai_disabled",
      "O transcritor alternativo não está habilitado.",
      false
    );
  }

  let transcriptId = options.existingTranscriptId;
  if (!transcriptId) {
    if (!audio)
      throw new JobProcessingError(
        "assemblyai_audio_missing",
        "O áudio não pôde ser aberto para transcrição.",
        true
      );
    const uploaded = uploadResponseSchema.parse(
      await (
        await assemblyFetch(env, "/v2/upload", {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: audio
        })
      ).json()
    );
    const submitted = submitResponseSchema.parse(
      await (
        await assemblyFetch(env, "/v2/transcript", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            audio_url: uploaded.upload_url,
            speech_models: [env.ASSEMBLYAI_TRANSCRIPTION_MODEL, "universal-2"],
            language_code: language,
            speaker_labels: true,
            punctuate: true,
            format_text: true,
            ...(context.trim()
              ? {
                  prompt: [
                    "Transcribe verbatim with standard punctuation.",
                    `Preserve technical terms using this class context: ${context.slice(0, 1200)}`
                  ].join(" ")
                }
              : {})
          })
        })
      ).json()
    );
    transcriptId = submitted.id;
    await options.onSubmitted?.(transcriptId);
  }

  const pollIntervalMs = options.pollIntervalMs ?? 3_000;
  const deadline = Date.now() + (options.timeoutMs ?? 8 * 60_000);
  while (Date.now() <= deadline) {
    const response = await assemblyFetch(env, `/v2/transcript/${encodeURIComponent(transcriptId)}`);
    const transcript = transcriptResponseSchema.parse(await response.json());
    if (transcript.status === "error") {
      throw new JobProcessingError(
        "assemblyai_transcription_failed",
        "O transcritor alternativo não conseguiu processar este áudio.",
        false
      );
    }
    if (transcript.status === "completed") {
      const segments = normalizedSegments(transcript);
      if (!segments.length) {
        throw new JobProcessingError(
          "assemblyai_no_speech",
          "O transcritor alternativo não identificou fala.",
          false
        );
      }
      return {
        data: { segments },
        model: env.ASSEMBLYAI_TRANSCRIPTION_MODEL,
        requestId: response.headers.get("x-request-id") ?? transcript.id,
        transcriptId: transcript.id
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new JobProcessingError(
    "assemblyai_still_processing",
    "A transcrição alternativa continua em processamento e será retomada.",
    true,
    15
  );
}
