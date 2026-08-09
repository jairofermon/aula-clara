import { Buffer } from "node:buffer";
import { z } from "zod";
import { JobProcessingError } from "./contracts";

const geminiResponseSchema = z
  .object({
    responseId: z.string().optional(),
    candidates: z
      .array(
        z.object({
          content: z.object({
            parts: z.array(z.object({ text: z.string().optional() }).passthrough())
          })
        })
      )
      .min(1),
    usageMetadata: z
      .object({
        promptTokenCount: z.number().int().nonnegative().optional(),
        candidatesTokenCount: z.number().int().nonnegative().optional()
      })
      .optional()
  })
  .passthrough();

const geminiTranscriptSchema = z
  .object({
    segments: z
      .array(
        z
          .object({
            start: z.number().nonnegative(),
            end: z.number().positive(),
            text: z.string().trim().min(1),
            speaker: z.string().trim().min(1).nullable().optional()
          })
          .strict()
      )
      .min(1)
  })
  .strict();

export function geminiEnabled(env: CloudflareEnv): boolean {
  return (
    env.GEMINI_DATA_PROCESSING_CONSENT === "accepted" &&
    typeof env.GEMINI_API_KEY === "string" &&
    env.GEMINI_API_KEY.length > 10
  );
}

function retryDelay(response: Response): number {
  const raw = response.headers.get("retry-after");
  const seconds = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) ? Math.max(5, Math.min(Math.ceil(seconds), 86_400)) : 60;
}

export async function chatWithGemini(
  env: CloudflareEnv,
  messages: ReadonlyArray<{ role: "system" | "user"; content: string }>,
  maxOutputTokens: number
) {
  if (!geminiEnabled(env)) {
    throw new JobProcessingError(
      "gemini_disabled",
      "O provedor alternativo não está habilitado.",
      false
    );
  }
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const user = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_GENERATION_MODEL)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens,
          responseMimeType: "application/json"
        }
      })
    }
  );
  if (!response.ok) {
    if (response.status === 429) {
      throw new JobProcessingError(
        "gemini_free_rate_limit",
        "A capacidade gratuita do provedor alternativo está ocupada.",
        true,
        retryDelay(response)
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new JobProcessingError(
        "gemini_not_authorized",
        "A integração alternativa precisa ser reconectada.",
        false
      );
    }
    throw new JobProcessingError(
      "gemini_unavailable",
      "O provedor alternativo está temporariamente indisponível.",
      response.status >= 500,
      response.status >= 500 ? 60 : undefined
    );
  }
  const parsed = geminiResponseSchema.parse(await response.json());
  const text = parsed.candidates[0]!.content.parts.map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) {
    throw new JobProcessingError(
      "invalid_provider_json",
      "O provedor alternativo retornou uma resposta vazia.",
      true
    );
  }
  return {
    response: text,
    inputUnits: parsed.usageMetadata?.promptTokenCount,
    outputUnits: parsed.usageMetadata?.candidatesTokenCount,
    requestId: response.headers.get("x-request-id") ?? parsed.responseId
  };
}

function audioMime(filename: string): string {
  const extension = filename.toLowerCase().split(".").at(-1);
  return (
    {
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      mp4: "audio/mp4",
      wav: "audio/wav",
      webm: "audio/webm"
    }[extension ?? ""] ?? "audio/mpeg"
  );
}

export async function transcribeWithGemini(
  env: CloudflareEnv,
  audio: ArrayBuffer,
  filename: string,
  language: string,
  context: string
) {
  if (!geminiEnabled(env)) {
    throw new JobProcessingError(
      "gemini_disabled",
      "O provedor alternativo não está habilitado.",
      false
    );
  }
  // Inline data is limited to a 20 MB total request. Audio chunks are kept below this
  // threshold by the preparation stage; the guard leaves room for base64 and prompts.
  if (audio.byteLength > 14 * 1024 * 1024) {
    throw new JobProcessingError(
      "gemini_inline_audio_too_large",
      "O bloco é grande demais para a rota alternativa de áudio.",
      false
    );
  }
  const schema = z.toJSONSchema(geminiTranscriptSchema);
  const prompt = [
    `Transcreva integralmente este áudio em ${language}.`,
    "Retorne segmentos em ordem, com início e fim em segundos, texto fiel e falante somente quando identificável.",
    "Não resuma, não omita falas e não invente conteúdo.",
    context.trim() ? `Contexto terminológico: ${context.slice(0, 1200)}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_GENERATION_MODEL)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: audioMime(filename),
                  data: Buffer.from(audio).toString("base64")
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: schema,
          maxOutputTokens: 16_000
        }
      })
    }
  );
  if (!response.ok) {
    if (response.status === 429) {
      throw new JobProcessingError(
        "gemini_free_rate_limit",
        "A cota gratuita de áudio alternativa está ocupada.",
        true,
        retryDelay(response)
      );
    }
    throw new JobProcessingError(
      "gemini_audio_unavailable",
      "A rota alternativa de áudio está indisponível.",
      response.status >= 500,
      60
    );
  }
  const parsed = geminiResponseSchema.parse(await response.json());
  const raw = parsed.candidates[0]!.content.parts.map((part) => part.text ?? "").join("");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new JobProcessingError(
      "invalid_provider_json",
      "A rota alternativa retornou uma transcrição inválida.",
      true
    );
  }
  return {
    data: geminiTranscriptSchema.parse(json),
    model: env.GEMINI_GENERATION_MODEL,
    requestId: response.headers.get("x-request-id") ?? parsed.responseId
  };
}
