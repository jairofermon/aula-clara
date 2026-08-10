import { z } from "zod";
import { JobProcessingError } from "./contracts";

const cerebrasResponseSchema = z
  .object({
    id: z.string().optional(),
    choices: z
      .array(
        z
          .object({ message: z.object({ content: z.string().nullable() }).passthrough() })
          .passthrough()
      )
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional()
      })
      .optional()
  })
  .passthrough();

function retryDelay(response: Response): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(Math.ceil(retryAfter), 86_400);
  const reset = Number(response.headers.get("x-ratelimit-reset-tokens-minute"));
  return Number.isFinite(reset) && reset > 0 ? Math.min(Math.ceil(reset), 86_400) : 15;
}

async function throwCerebrasError(response: Response): Promise<never> {
  if (response.status === 429) {
    throw new JobProcessingError(
      "cerebras_free_rate_limit",
      "A capacidade gratuita do Cerebras está ocupada. O próximo provedor será tentado.",
      true,
      retryDelay(response)
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new JobProcessingError(
      "cerebras_not_authorized",
      "A integração com o Cerebras precisa ser reconectada.",
      false
    );
  }
  if (response.status === 413) {
    throw new JobProcessingError(
      "cerebras_request_too_large",
      "O lote excedeu o limite do Cerebras. O próximo provedor será tentado.",
      true,
      1
    );
  }
  if (response.status >= 500) {
    throw new JobProcessingError(
      "cerebras_unavailable",
      "O Cerebras está temporariamente indisponível. O próximo provedor será tentado.",
      true,
      10
    );
  }
  throw new JobProcessingError(
    "cerebras_invalid_request",
    "O Cerebras recusou esta etapa. O próximo provedor será tentado.",
    false
  );
}

export function cerebrasEnabled(env: CloudflareEnv): boolean {
  return typeof env.CEREBRAS_API_KEY === "string" && env.CEREBRAS_API_KEY.length > 10;
}

export async function chatWithCerebras(
  env: CloudflareEnv,
  messages: ReadonlyArray<{ role: "system" | "user"; content: string }>,
  responseFormat: Record<string, unknown> | undefined,
  maxCompletionTokens: number
) {
  const response = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CEREBRAS_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: env.CEREBRAS_GENERATION_MODEL,
      messages,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      temperature: 0.1,
      max_completion_tokens: maxCompletionTokens,
      reasoning_effort: "low"
    })
  });
  if (!response.ok) await throwCerebrasError(response);
  const parsed = cerebrasResponseSchema.parse(await response.json());
  return {
    response: parsed.choices[0]!.message.content ?? "",
    inputUnits: parsed.usage?.prompt_tokens,
    outputUnits: parsed.usage?.completion_tokens,
    requestId: response.headers.get("x-request-id") ?? parsed.id
  };
}
