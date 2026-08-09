import { z } from "zod";
import { JobProcessingError } from "./contracts";

const responseSchema = z
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
      .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
      .optional()
  })
  .passthrough();

export function openRouterEnabled(env: CloudflareEnv): boolean {
  return (
    String(env.OPENROUTER_DATA_PROCESSING_CONSENT) === "accepted" &&
    typeof env.OPENROUTER_API_KEY === "string" &&
    env.OPENROUTER_API_KEY.length > 10
  );
}

export async function chatWithOpenRouter(
  env: CloudflareEnv,
  messages: ReadonlyArray<{ role: "system" | "user"; content: string }>,
  maxTokens: number
) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "http-referer": "https://aula-clara.jairofermon.workers.dev",
      "x-title": "Aula Clara"
    },
    body: JSON.stringify({
      model: env.OPENROUTER_GENERATION_MODEL,
      messages,
      temperature: 0.1,
      max_tokens: maxTokens
    })
  });
  if (!response.ok) {
    if (response.status === 429) {
      throw new JobProcessingError(
        "openrouter_free_rate_limit",
        "A capacidade gratuita dos modelos de reserva está ocupada.",
        true,
        300
      );
    }
    throw new JobProcessingError(
      "openrouter_unavailable",
      "Os modelos gratuitos de reserva estão indisponíveis.",
      response.status >= 500,
      60
    );
  }
  const parsed = responseSchema.parse(await response.json());
  return {
    response: parsed.choices[0]!.message.content ?? "",
    inputUnits: parsed.usage?.prompt_tokens,
    outputUnits: parsed.usage?.completion_tokens,
    requestId: response.headers.get("x-request-id") ?? parsed.id
  };
}
