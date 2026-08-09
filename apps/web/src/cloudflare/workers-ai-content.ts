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
import { chatWithGemini, geminiEnabled } from "./gemini-provider";
import { chatWithOpenRouter, openRouterEnabled } from "./openrouter-provider";

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

const globalReviewSchema = z
  .object({
    checked_segments: z.number().int().positive(),
    patches: z.array(indexedReviewedSegmentSchema)
  })
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

function validateStructuredResponse<T>(
  raw: unknown,
  schema: z.ZodType<T>,
  metrics: { inputUnits?: number; outputUnits?: number; requestId?: string } = {}
): StructuredResult<T> {
  const envelope = workersAiJsonResponseSchema.safeParse(raw);
  const candidate = parseJsonValue(envelope.success ? envelope.data.response : raw);
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    throw new JobProcessingError(
      "invalid_provider_schema",
      "O modelo não respeitou o formato esperado. O próximo provedor será tentado.",
      true
    );
  }
  return {
    data: parsed.data,
    inputUnits:
      metrics.inputUnits ?? (envelope.success ? envelope.data.usage?.prompt_tokens : undefined),
    outputUnits:
      metrics.outputUnits ??
      (envelope.success ? envelope.data.usage?.completion_tokens : undefined),
    requestId: metrics.requestId
  };
}

async function runStructured<T>(
  env: CloudflareEnv,
  model: string,
  schema: z.ZodType<T>,
  system: string,
  payload: unknown,
  jsonObjectMode = false,
  maxTokens = 6000,
  cloudflareFallbackModel = env.CLOUDFLARE_GENERATION_MODEL
): Promise<StructuredResult<T>> {
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
  const failures: JobProcessingError[] = [];
  if (groqEnabled(env)) {
    try {
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
      return validateStructuredResponse(result.response, schema, result);
    } catch (error) {
      failures.push(classifyWorkersAiError(error));
    }
  }
  if (geminiEnabled(env)) {
    try {
      const result = await chatWithGemini(env, messages, maxTokens);
      return validateStructuredResponse(result.response, schema, result);
    } catch (error) {
      failures.push(classifyWorkersAiError(error));
    }
  }
  try {
    const raw = await env.AI.run(cloudflareFallbackModel, cloudflareRequest);
    return validateStructuredResponse(raw, schema, {
      requestId: env.AI.aiGatewayLogId ?? undefined
    });
  } catch (error) {
    failures.push(classifyWorkersAiError(error));
  }
  if (openRouterEnabled(env)) {
    try {
      const result = await chatWithOpenRouter(env, messages, maxTokens);
      return validateStructuredResponse(result.response, schema, result);
    } catch (error) {
      failures.push(classifyWorkersAiError(error));
    }
  }
  throw failures.slice(1).reduce(earliestRetry, failures[0] ?? classifyWorkersAiError(null));
}

async function reviewSingleAsPlainText(
  env: CloudflareEnv,
  segment: {
    segment_id: string;
    raw_text: string;
    start_ms: number;
    end_ms: number;
  },
  context: string,
  model: string
): Promise<
  StructuredResult<{
    segments: Array<{ segment_id: string; revised_text: string; confidence: number }>;
  }>
> {
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
  const validate = (
    raw: unknown,
    metrics: { inputUnits?: number; outputUnits?: number; requestId?: string } = {}
  ) => {
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
      revised.length >= minimumLength &&
      revised.length <= maximumLength &&
      !revised.startsWith("{");
    if (!usable) {
      throw new JobProcessingError(
        "invalid_provider_schema",
        "A revisão não produziu texto válido. O próximo provedor será tentado.",
        true
      );
    }
    return {
      data: {
        segments: [{ segment_id: segment.segment_id, revised_text: revised, confidence: 0.75 }]
      },
      inputUnits:
        metrics.inputUnits ?? (envelope.success ? envelope.data.usage?.prompt_tokens : undefined),
      outputUnits:
        metrics.outputUnits ??
        (envelope.success ? envelope.data.usage?.completion_tokens : undefined),
      requestId: metrics.requestId
    };
  };
  const failures: JobProcessingError[] = [];
  if (groqEnabled(env)) {
    try {
      const result = await chatWithGroq(env, model, messages, undefined, 3000);
      return validate(result.response, result);
    } catch (error) {
      failures.push(classifyWorkersAiError(error));
    }
  }
  if (geminiEnabled(env)) {
    try {
      const result = await chatWithGemini(env, messages, 3000);
      return validate(result.response, result);
    } catch (error) {
      failures.push(classifyWorkersAiError(error));
    }
  }
  try {
    const raw = await env.AI.run(env.CLOUDFLARE_REVIEW_MODEL, {
      messages,
      temperature: 0.1,
      max_tokens: 3000
    });
    return validate(raw, { requestId: env.AI.aiGatewayLogId ?? undefined });
  } catch (error) {
    failures.push(classifyWorkersAiError(error));
  }
  if (openRouterEnabled(env)) {
    try {
      const result = await chatWithOpenRouter(env, messages, 3000);
      return validate(result.response, result);
    } catch (error) {
      failures.push(classifyWorkersAiError(error));
    }
  }
  throw failures.slice(1).reduce(earliestRetry, failures[0] ?? classifyWorkersAiError(null));
}

export async function reviewWithWorkersAi(
  env: CloudflareEnv,
  segments: ReadonlyArray<{
    segment_id: string;
    raw_text: string;
    start_ms: number;
    end_ms: number;
  }>,
  context: string,
  model = activeReviewModel(env)
) {
  let result: Awaited<ReturnType<typeof runStructured<z.infer<typeof indexedReviewBatchSchema>>>>;
  try {
    result = await runStructured(
      env,
      model,
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
      2500,
      env.CLOUDFLARE_REVIEW_MODEL
    );
  } catch (error) {
    const recoverableReviewError =
      error instanceof JobProcessingError &&
      ["invalid_provider_json", "invalid_provider_schema", "groq_invalid_request"].includes(
        error.code
      );
    if (recoverableReviewError && segments.length === 1) {
      return reviewSingleAsPlainText(env, segments[0]!, context, model);
    }
    throw error;
  }
  const returned = result.data.segments.map((segment) => segment.index);
  if (
    returned.length !== segments.length ||
    new Set(returned).size !== returned.length ||
    returned.some((index) => index < 0 || index >= segments.length)
  ) {
    if (segments.length === 1) return reviewSingleAsPlainText(env, segments[0]!, context, model);
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

export async function reviewWholeTranscriptWithWorkersAi(
  env: CloudflareEnv,
  segments: ReadonlyArray<{
    segment_id: string;
    raw_text: string;
    start_ms: number;
    end_ms: number;
  }>,
  context: string
) {
  const result = await runStructured(
    env,
    activeGenerationModel(env),
    globalReviewSchema,
    `${REVIEW_RULES} Esta é a segunda e última revisão. Analise a transcrição inteira como uma aula contínua. Identifique incoerências entre trechos, erros contextuais de reconhecimento, termos técnicos inconsistentes, repetições acidentais e frases ainda pouco claras. Não resuma, não omita conteúdo e não altere timestamps. Retorne checked_segments com a quantidade total recebida e, em patches, somente os índices que realmente precisam mudar.`,
    {
      context: context.slice(0, 12000),
      transcript: segments.map((segment, index) => ({
        index,
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
        text: segment.raw_text
      }))
    },
    true,
    16000,
    env.CLOUDFLARE_GENERATION_MODEL
  );
  if (result.data.checked_segments !== segments.length) {
    throw new JobProcessingError(
      "global_review_coverage_mismatch",
      "A revisão final não confirmou a leitura integral. Uma nova tentativa será feita.",
      true
    );
  }
  const indexes = result.data.patches.map((patch) => patch.index);
  if (
    new Set(indexes).size !== indexes.length ||
    indexes.some((index) => index < 0 || index >= segments.length)
  ) {
    throw new JobProcessingError(
      "global_review_segment_mismatch",
      "A revisão final citou um trecho inválido. Uma nova tentativa será feita.",
      true
    );
  }
  return {
    ...result,
    data: {
      checked_segments: result.data.checked_segments,
      patches: result.data.patches.map(({ index, ...patch }) => ({
        ...patch,
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
    materialType === "questions" || materialType === "mindmap",
    6000,
    env.CLOUDFLARE_GENERATION_MODEL
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
