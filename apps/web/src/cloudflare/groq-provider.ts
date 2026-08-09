import { z } from "zod";
import { JobProcessingError } from "./contracts";

const groqChatResponseSchema = z
  .object({
    id: z.string().optional(),
    choices: z
      .array(z.object({ message: z.object({ content: z.string().nullable() }).strip() }).strip())
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional()
      })
      .strip()
      .optional()
  })
  .strip();

function retryDelay(response: Response): number {
  const raw = response.headers.get("retry-after");
  const seconds = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) ? Math.max(5, Math.min(Math.ceil(seconds), 86_400)) : 3_600;
}

async function groqError(response: Response): Promise<never> {
  if (response.status === 429) {
    throw new JobProcessingError(
      "groq_free_rate_limit",
      "A capacidade gratuita está ocupada. O processamento será retomado automaticamente na próxima janela disponível.",
      true,
      retryDelay(response)
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new JobProcessingError(
      "groq_not_authorized",
      "A integração gratuita de inteligência artificial precisa ser reconectada.",
      false
    );
  }
  if (response.status >= 500) {
    throw new JobProcessingError(
      "groq_unavailable",
      "O provedor gratuito está temporariamente indisponível. A tentativa será automática.",
      true,
      60
    );
  }
  throw new JobProcessingError(
    "groq_invalid_request",
    "O provedor gratuito recusou esta etapa. Os detalhes técnicos foram preservados para diagnóstico.",
    false
  );
}

async function groqFetch(env: CloudflareEnv, path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`https://api.groq.com/openai/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GROQ_API_KEY}`,
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) await groqError(response);
  return response;
}

export function groqEnabled(env: CloudflareEnv): boolean {
  return typeof env.GROQ_API_KEY === "string" && env.GROQ_API_KEY.length > 10;
}

export async function transcribeWithGroq(
  env: CloudflareEnv,
  audio: ArrayBuffer,
  filename: string,
  language: string,
  context: string
) {
  const form = new FormData();
  form.set("file", new Blob([audio]), filename);
  form.set("model", env.GROQ_TRANSCRIPTION_MODEL);
  form.set("language", language);
  form.set("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  if (context.trim()) form.set("prompt", context.slice(0, 900));

  const response = await groqFetch(env, "/audio/transcriptions", { method: "POST", body: form });
  return {
    data: (await response.json()) as unknown,
    model: env.GROQ_TRANSCRIPTION_MODEL,
    requestId: response.headers.get("x-request-id") ?? undefined
  };
}

export async function chatWithGroq(
  env: CloudflareEnv,
  model: string,
  messages: ReadonlyArray<{ role: "system" | "user"; content: string }>,
  responseFormat: Record<string, unknown> | undefined,
  maxCompletionTokens: number
) {
  const response = await groqFetch(env, "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      temperature: 0.1,
      max_completion_tokens: maxCompletionTokens
    })
  });
  const parsed = groqChatResponseSchema.parse(await response.json());
  return {
    response: parsed.choices[0]!.message.content ?? "",
    inputUnits: parsed.usage?.prompt_tokens,
    outputUnits: parsed.usage?.completion_tokens,
    requestId: response.headers.get("x-request-id") ?? parsed.id
  };
}

export function activeReviewModel(env: CloudflareEnv): string {
  return groqEnabled(env) ? env.GROQ_REVIEW_MODEL : env.CLOUDFLARE_REVIEW_MODEL;
}

export function activeGenerationModel(env: CloudflareEnv): string {
  return groqEnabled(env) ? env.GROQ_GENERATION_MODEL : env.CLOUDFLARE_GENERATION_MODEL;
}
