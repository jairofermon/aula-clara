import {
  flashcardsContentSchema,
  mindmapContentSchema,
  notesContentSchema,
  questionsContentSchema,
  summaryContentSchema
} from "@aula-clara/shared";
import { REVIEW_RULES } from "@aula-clara/prompts";
import { z } from "zod";
import { JobProcessingError, workersAiJsonResponseSchema } from "./contracts";
import {
  activeGenerationModel,
  activeReviewModel,
  chatWithGroq,
  groqEnabled
} from "./groq-provider";

interface StructuredResult<T> {
  data: T;
  inputUnits?: number;
  outputUnits?: number;
  requestId?: string;
}

function classifyWorkersAiError(error: unknown): JobProcessingError {
  if (error instanceof JobProcessingError) return error;
  const details = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : "";
  if (details.includes("3036") || details.includes("daily free allocation")) {
    const now = new Date();
    const nextUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1);
    return new JobProcessingError(
      "cloudflare_daily_quota",
      "A cota gratuita diária de inteligência artificial foi atingida. O processamento será retomado após a renovação.",
      true,
      Math.max(60, Math.ceil((nextUtc - now.getTime()) / 1000))
    );
  }
  return new JobProcessingError(
    "cloudflare_ai_unavailable",
    "O serviço de geração está temporariamente indisponível.",
    true
  );
}

function earliestRetry(
  primary: JobProcessingError,
  fallback: JobProcessingError
): JobProcessingError {
  if (!primary.transient) return fallback;
  if (!fallback.transient) return primary;
  return (primary.retryDelaySeconds ?? 3600) <= (fallback.retryDelaySeconds ?? 3600)
    ? primary
    : fallback;
}

const indexedReviewedSegmentSchema = z
  .object({
    index: z.number().int().nonnegative(),
    revised_text: z.string().trim().min(1),
    confidence: z.number().min(0).max(1)
  })
  .strict();

const indexedReviewBatchSchema = z
  .object({ segments: z.array(indexedReviewedSegmentSchema).min(1) })
  .strict();

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    const fenced = value.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/iu)?.[1];
    if (fenced) {
      try {
        return JSON.parse(fenced) as unknown;
      } catch {
        // Fall through to the same validated provider error used for plain JSON.
      }
    }
    throw new JobProcessingError(
      "invalid_provider_json",
      "O modelo retornou JSON inválido. Uma nova tentativa será feita.",
      true
    );
  }
}

async function runStructured<T>(
  env: CloudflareEnv,
  model: string,
  schema: z.ZodType<T>,
  system: string,
  payload: unknown,
  jsonObjectMode = false,
  maxTokens = 6000
): Promise<StructuredResult<T>> {
  let raw: unknown;
  let inputUnits: number | undefined;
  let outputUnits: number | undefined;
  let requestId: string | undefined;
  const jsonSchema = z.toJSONSchema(schema);
  const messages = [
    {
      role: "system" as const,
      content: `${system} Responda somente com um objeto JSON válido que satisfaça rigorosamente este JSON Schema: ${JSON.stringify(jsonSchema)}`
    },
    { role: "user" as const, content: JSON.stringify(payload) }
  ];
  const cloudflareRequest = {
    messages,
    response_format: jsonObjectMode
      ? { type: "json_object" }
      : { type: "json_schema", json_schema: jsonSchema },
    temperature: 0.1,
    max_tokens: maxTokens
  };
  try {
    if (groqEnabled(env)) {
      const strictSchema = model.startsWith("openai/gpt-oss");
      const result = await chatWithGroq(
        env,
        model,
        messages,
        strictSchema
          ? {
              type: "json_schema",
              json_schema: { name: "aula_clara_response", strict: true, schema: jsonSchema }
            }
          : { type: "json_object" },
        maxTokens
      );
      raw = result.response;
      inputUnits = result.inputUnits;
      outputUnits = result.outputUnits;
      requestId = result.requestId;
    } else {
      raw = await env.AI.run(model, cloudflareRequest);
    }
  } catch (error) {
    const failure = classifyWorkersAiError(error);
    const canUseCloudflareFallback =
      groqEnabled(env) &&
      ["groq_free_rate_limit", "groq_unavailable", "groq_request_too_large"].includes(failure.code);
    if (!canUseCloudflareFallback) throw failure;
    const fallbackModel =
      model === env.GROQ_REVIEW_MODEL
        ? env.CLOUDFLARE_REVIEW_MODEL
        : env.CLOUDFLARE_GENERATION_MODEL;
    try {
      raw = await env.AI.run(fallbackModel, cloudflareRequest);
      requestId = env.AI.aiGatewayLogId ?? undefined;
    } catch (fallbackError) {
      throw earliestRetry(failure, classifyWorkersAiError(fallbackError));
    }
  }

  const envelope = workersAiJsonResponseSchema.safeParse(raw);
  const candidate = parseJsonValue(envelope.success ? envelope.data.response : raw);
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    throw new JobProcessingError(
      "invalid_provider_schema",
      "O modelo não respeitou o formato esperado. Uma nova tentativa será feita.",
      true
    );
  }
  return {
    data: parsed.data,
    inputUnits: inputUnits ?? (envelope.success ? envelope.data.usage?.prompt_tokens : undefined),
    outputUnits:
      outputUnits ?? (envelope.success ? envelope.data.usage?.completion_tokens : undefined),
    requestId: requestId ?? env.AI.aiGatewayLogId ?? undefined
  };
}

async function reviewSingleAsPlainText(
  env: CloudflareEnv,
  segment: {
    segment_id: string;
    raw_text: string;
    start_ms: number;
    end_ms: number;
  },
  context: string
): Promise<
  StructuredResult<{
    segments: Array<{ segment_id: string; revised_text: string; confidence: number }>;
  }>
> {
  let raw: unknown;
  let inputUnits: number | undefined;
  let outputUnits: number | undefined;
  let requestId: string | undefined;
  const messages = [
    {
      role: "system" as const,
      content: `${REVIEW_RULES} Retorne somente o texto final corrigido, sem JSON, título, explicação, aspas ou Markdown.`
    },
    {
      role: "user" as const,
      content: `Contexto: ${context.slice(0, 3000)}\n\nTranscrição: ${segment.raw_text}`
    }
  ];
  try {
    if (groqEnabled(env)) {
      const result = await chatWithGroq(env, activeReviewModel(env), messages, undefined, 3000);
      raw = result.response;
      inputUnits = result.inputUnits;
      outputUnits = result.outputUnits;
      requestId = result.requestId;
    } else {
      raw = await env.AI.run(env.CLOUDFLARE_REVIEW_MODEL, {
        messages,
        temperature: 0.1,
        max_tokens: 3000
      });
    }
  } catch (error) {
    const failure = classifyWorkersAiError(error);
    if (
      ![
        "groq_invalid_request",
        "groq_free_rate_limit",
        "groq_unavailable",
        "groq_request_too_large"
      ].includes(failure.code) ||
      !groqEnabled(env)
    ) {
      throw failure;
    }
    try {
      raw = await env.AI.run(env.CLOUDFLARE_REVIEW_MODEL, {
        messages,
        temperature: 0.1,
        max_tokens: 3000
      });
      requestId = env.AI.aiGatewayLogId ?? undefined;
    } catch (fallbackError) {
      throw earliestRetry(failure, classifyWorkersAiError(fallbackError));
    }
  }

  const envelope = workersAiJsonResponseSchema.safeParse(raw);
  const candidate = envelope.success ? envelope.data.response : raw;
  let revised = typeof candidate === "string" ? candidate.trim() : "";
  const fenced = revised.match(/^\s*```(?:text|markdown)?\s*([\s\S]*?)\s*```\s*$/iu)?.[1];
  if (fenced) revised = fenced.trim();
  try {
    const decoded = JSON.parse(revised) as unknown;
    if (typeof decoded === "string") revised = decoded.trim();
  } catch {
    // A resposta esperada aqui é texto simples, não JSON.
  }

  const minimumLength = segment.raw_text.length > 120 ? segment.raw_text.length * 0.35 : 1;
  const maximumLength = Math.max(1000, segment.raw_text.length * 3);
  const usable =
    revised.length >= minimumLength && revised.length <= maximumLength && !revised.startsWith("{");

  if (!usable) {
    throw new JobProcessingError(
      "invalid_provider_schema",
      "A revisão não produziu um texto final válido. Uma nova tentativa será feita automaticamente.",
      true
    );
  }

  return {
    data: {
      segments: [
        {
          segment_id: segment.segment_id,
          revised_text: revised,
          confidence: 0.75
        }
      ]
    },
    inputUnits: inputUnits ?? (envelope.success ? envelope.data.usage?.prompt_tokens : undefined),
    outputUnits:
      outputUnits ?? (envelope.success ? envelope.data.usage?.completion_tokens : undefined),
    requestId: requestId ?? env.AI.aiGatewayLogId ?? undefined
  };
}

export async function reviewWithWorkersAi(
  env: CloudflareEnv,
  segments: ReadonlyArray<{
    segment_id: string;
    raw_text: string;
    start_ms: number;
    end_ms: number;
  }>,
  context: string
) {
  let result: Awaited<ReturnType<typeof runStructured<z.infer<typeof indexedReviewBatchSchema>>>>;
  try {
    result = await runStructured(
      env,
      activeReviewModel(env),
      indexedReviewBatchSchema,
      `${REVIEW_RULES} Leia os segmentos como partes consecutivas da mesma aula. Corrija erros de reconhecimento, pontuação, concordância e frases quebradas para produzir uma transcrição clara, coerente e fácil de entender, sem resumir, omitir exemplos ou inventar informações. Preserve exatamente todos os índices recebidos, uma única vez e na mesma ordem. Entregue uma versão final utilizável; não crie pendências nem peça confirmação. Não use HTML.`,
      {
        segments: segments.map((segment, index) => ({
          index,
          raw_text: segment.raw_text,
          start_ms: segment.start_ms,
          end_ms: segment.end_ms
        })),
        context: context.slice(0, 8000)
      },
      false,
      2500
    );
  } catch (error) {
    const recoverableReviewError =
      error instanceof JobProcessingError &&
      ["invalid_provider_json", "invalid_provider_schema", "groq_invalid_request"].includes(
        error.code
      );
    if (recoverableReviewError && segments.length === 1) {
      return reviewSingleAsPlainText(env, segments[0]!, context);
    }
    throw error;
  }
  const returned = result.data.segments.map((segment) => segment.index);
  if (
    returned.length !== segments.length ||
    new Set(returned).size !== returned.length ||
    returned.some((index) => index < 0 || index >= segments.length)
  ) {
    if (segments.length === 1) return reviewSingleAsPlainText(env, segments[0]!, context);
    throw new JobProcessingError(
      "review_segment_ids_mismatch",
      "A revisão não preservou os segmentos recebidos. Uma nova tentativa será feita.",
      true
    );
  }
  return {
    ...result,
    data: {
      segments: [...result.data.segments]
        .sort((left, right) => left.index - right.index)
        .map(({ index, ...segment }) => ({
          ...segment,
          segment_id: segments[index]!.segment_id
        }))
    }
  };
}

const materialSchemas = {
  notes: notesContentSchema,
  summary: summaryContentSchema,
  flashcards: flashcardsContentSchema,
  questions: questionsContentSchema,
  mindmap: mindmapContentSchema
} as const;

export type GeneratableMaterial = keyof typeof materialSchemas;

function verifySourceReferences(
  value: unknown,
  allowedSegmentIds: ReadonlySet<string>,
  maximumTimestampMs: number
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => verifySourceReferences(item, allowedSegmentIds, maximumTimestampMs));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "source_segment_ids" && Array.isArray(item)) {
      if (item.some((id) => typeof id !== "string" || !allowedSegmentIds.has(id))) {
        throw new JobProcessingError(
          "material_source_mismatch",
          "O material citou um trecho inexistente. Uma nova tentativa será feita.",
          true
        );
      }
    } else if (key === "timestamp_ms" && typeof item === "number") {
      if (item < 0 || item > maximumTimestampMs) {
        throw new JobProcessingError(
          "material_timestamp_mismatch",
          "O material citou um tempo fora da aula. Uma nova tentativa será feita.",
          true
        );
      }
    } else {
      verifySourceReferences(item, allowedSegmentIds, maximumTimestampMs);
    }
  }
}

export async function generateWithWorkersAi(
  env: CloudflareEnv,
  materialType: GeneratableMaterial,
  transcript: ReadonlyArray<{
    segment_id: string;
    start_ms: number;
    end_ms: number;
    speaker_label: string | null;
    text: string;
  }>,
  classContext: Record<string, unknown>
) {
  const schema = materialSchemas[materialType] as z.ZodType<unknown>;
  const result = await runStructured(
    env,
    activeGenerationModel(env),
    schema,
    "Gere material de estudo em português usando exclusivamente a transcrição validada. Preserve timestamps em milissegundos e IDs de origem. Não use HTML. Em questões, gere cinco alternativas distintas, exatamente uma correta e explique todas. No Mermaid, use somente mindmap com labels de texto simples.",
    { class: classContext, transcript },
    materialType === "questions" || materialType === "mindmap"
  );
  verifySourceReferences(
    result.data,
    new Set(transcript.map((segment) => segment.segment_id)),
    Math.max(...transcript.map((segment) => segment.end_ms))
  );
  return result;
}

export function markdownForMaterial(
  materialType: GeneratableMaterial,
  content: unknown
): string | null {
  if (materialType === "notes") {
    const notes = notesContentSchema.parse(content);
    const lines = [
      `# ${notes.title}`,
      "",
      "## Índice cronológico",
      ...notes.chronological_index.map((item) => `- ${item}`)
    ];
    for (const section of notes.sections) {
      lines.push(
        "",
        `## ${section.title}`,
        section.body,
        ``,
        `Timestamp: ${section.timestamp_ms} ms`
      );
    }
    if (notes.emphasized_points.length)
      lines.push(
        "",
        "## Pontos enfatizados",
        ...notes.emphasized_points.map((item) => `- ${item}`)
      );
    if (notes.teacher_examples.length)
      lines.push(
        "",
        "## Exemplos do professor",
        ...notes.teacher_examples.map((item) => `- ${item}`)
      );
    if (notes.remaining_questions.length)
      lines.push(
        "",
        "## Dúvidas remanescentes",
        ...notes.remaining_questions.map((item) => `- ${item}`)
      );
    return lines.join("\n");
  }
  if (materialType === "summary") {
    const summary = summaryContentSchema.parse(content);
    return [
      "# Resumo",
      "",
      summary.overview,
      "",
      "## Conceitos",
      ...summary.concepts.map((item) => `- ${item}`),
      "",
      "## Pontos para prova",
      ...summary.exam_items.map((item) => `- ${item}`)
    ].join("\n");
  }
  return null;
}
