import { z } from "zod";
import { JobProcessingError } from "./contracts";

const deepgramWordSchema = z
  .object({
    word: z.string().optional(),
    punctuated_word: z.string().optional(),
    start: z.number().nonnegative(),
    end: z.number().positive(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    speaker: z.number().int().nonnegative().nullable().optional()
  })
  .passthrough();

const deepgramUtteranceSchema = z
  .object({
    transcript: z.string().trim().min(1),
    start: z.number().nonnegative(),
    end: z.number().positive(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    speaker: z.number().int().nonnegative().nullable().optional(),
    words: z.array(deepgramWordSchema).optional()
  })
  .passthrough();

const deepgramResponseSchema = z
  .object({
    metadata: z
      .object({
        request_id: z.string().optional()
      })
      .passthrough()
      .optional(),
    results: z
      .object({
        utterances: z.array(deepgramUtteranceSchema).optional(),
        channels: z
          .array(
            z
              .object({
                alternatives: z
                  .array(
                    z
                      .object({
                        transcript: z.string().optional(),
                        confidence: z.number().min(0).max(1).nullable().optional(),
                        words: z.array(deepgramWordSchema).optional()
                      })
                      .passthrough()
                  )
                  .optional()
              })
              .passthrough()
          )
          .optional()
      })
      .passthrough()
  })
  .passthrough();

type DeepgramWord = z.infer<typeof deepgramWordSchema>;

function retryDelay(response: Response): number {
  const raw = response.headers.get("retry-after");
  const seconds = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) ? Math.max(5, Math.min(Math.ceil(seconds), 86_400)) : 60;
}

async function deepgramError(response: Response): Promise<never> {
  if (response.status === 429) {
    throw new JobProcessingError(
      "deepgram_rate_limit",
      "A capacidade do transcritor de reserva está ocupada.",
      true,
      retryDelay(response)
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new JobProcessingError(
      "deepgram_not_authorized",
      "A integração do transcritor de reserva precisa ser reconectada.",
      false
    );
  }
  if (response.status === 402) {
    throw new JobProcessingError(
      "deepgram_credits_exhausted",
      "Os créditos do transcritor de reserva terminaram.",
      false
    );
  }
  if (response.status === 413) {
    throw new JobProcessingError(
      "deepgram_audio_too_large",
      "O bloco excede o limite do transcritor de reserva.",
      false
    );
  }
  if (response.status >= 500) {
    throw new JobProcessingError(
      "deepgram_unavailable",
      "O transcritor de reserva está temporariamente indisponível.",
      true,
      60
    );
  }
  throw new JobProcessingError(
    "deepgram_invalid_request",
    "O transcritor de reserva recusou este áudio.",
    false
  );
}

function audioMime(filename: string): string {
  const extension = filename.toLowerCase().split(".").at(-1);
  return (
    {
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      mp4: "video/mp4",
      wav: "audio/wav",
      webm: "audio/webm"
    }[extension ?? ""] ?? "application/octet-stream"
  );
}

function splitWords(words: DeepgramWord[]) {
  const segments: DeepgramWord[][] = [];
  let current: DeepgramWord[] = [];
  for (const word of words) {
    const speakerChanged =
      current.length > 0 && current[0]!.speaker != null && word.speaker !== current[0]!.speaker;
    if (speakerChanged) {
      segments.push(current);
      current = [];
    }
    current.push(word);
    const visibleWord = word.punctuated_word ?? word.word ?? "";
    const elapsed = word.end - current[0]!.start;
    if (/[.!?…]$/.test(visibleWord) || elapsed >= 12 || current.length >= 35) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length) segments.push(current);
  return segments.map((items) => ({
    text: items
      .map((word) => word.punctuated_word ?? word.word ?? "")
      .join(" ")
      .trim(),
    start: items[0]!.start,
    end: items.at(-1)!.end,
    speaker: items[0]!.speaker == null ? null : `Speaker ${items[0]!.speaker + 1}`,
    confidence: items.reduce((sum, word) => sum + (word.confidence ?? 0), 0) / items.length
  }));
}

export function deepgramEnabled(env: CloudflareEnv): boolean {
  return typeof env.DEEPGRAM_API_KEY === "string" && env.DEEPGRAM_API_KEY.length > 10;
}

export async function transcribeWithDeepgram(
  env: CloudflareEnv,
  audio: ArrayBuffer,
  filename: string,
  language: string
) {
  if (!deepgramEnabled(env)) {
    throw new JobProcessingError(
      "deepgram_disabled",
      "O transcritor de reserva não está habilitado.",
      false
    );
  }
  const query = new URLSearchParams({
    model: env.DEEPGRAM_TRANSCRIPTION_MODEL,
    language,
    smart_format: "true",
    punctuate: "true",
    utterances: "true",
    diarize_model: "latest"
  });
  const response = await fetch(`https://api.deepgram.com/v1/listen?${query}`, {
    method: "POST",
    headers: {
      authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      "content-type": audioMime(filename)
    },
    body: audio
  });
  if (!response.ok) await deepgramError(response);
  const parsed = deepgramResponseSchema.parse(await response.json());
  const utterances = parsed.results.utterances ?? [];
  const alternative = parsed.results.channels?.[0]?.alternatives?.[0];
  const segments = utterances.length
    ? utterances.map((utterance) => ({
        text: utterance.transcript,
        start: utterance.start,
        end: utterance.end,
        speaker: utterance.speaker == null ? null : `Speaker ${utterance.speaker + 1}`,
        confidence: utterance.confidence ?? null
      }))
    : splitWords(alternative?.words ?? []);
  if (!segments.length) {
    throw new JobProcessingError(
      "deepgram_no_speech",
      "O transcritor de reserva não identificou fala.",
      false
    );
  }
  return {
    data: { segments },
    model: env.DEEPGRAM_TRANSCRIPTION_MODEL,
    requestId: response.headers.get("x-request-id") ?? parsed.metadata?.request_id
  };
}
