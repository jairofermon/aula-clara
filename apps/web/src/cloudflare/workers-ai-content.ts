import {
  flashcardsContentSchema,
  formatTimestamp,
  mindmapContentSchema,
  notesContentSchema,
  questionsContentSchema,
  summaryContentSchema,
  type MindmapNodeContent
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
import { cerebrasEnabled, chatWithCerebras } from "./cerebras-provider";

interface StructuredResult<T> {
  data: T;
  modelName?: string;
  inputUnits?: number;
  outputUnits?: number;
  requestId?: string;
}

function withProviderTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new JobProcessingError(
          "provider_timeout",
          "O provedor demorou demais e a próxima opção será tentada.",
          true,
          5
        )
      );
    }, timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function classifyWorkersAiError(error: unknown): JobProcessingError {
  if (error instanceof JobProcessingError) return error;
  if (error instanceof z.ZodError) {
    return new JobProcessingError(
      "invalid_provider_schema",
      "O provedor retornou uma estrutura inválida. A próxima opção será tentada.",
      true,
      5
    );
  }
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
      true,
      5
    );
  }
}

function validateStructuredResponse<T>(
  raw: unknown,
  schema: z.ZodType<T>,
  metrics: {
    inputUnits?: number;
    outputUnits?: number;
    requestId?: string;
    modelName?: string;
  } = {}
): StructuredResult<T> {
  const envelope = workersAiJsonResponseSchema.safeParse(raw);
  const candidate = parseJsonValue(envelope.success ? envelope.data.response : raw);
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    throw new JobProcessingError(
      "invalid_provider_schema",
      "O modelo não respeitou o formato esperado. O próximo provedor será tentado.",
      true,
      5
    );
  }
  return {
    data: parsed.data,
    modelName: metrics.modelName,
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
  cloudflareFallbackModel = env.CLOUDFLARE_GENERATION_MODEL,
  providerTimeoutMs = 45_000,
  qualityCheck?: (data: T) => void
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
  const rememberFailure = (provider: string, error: unknown) => {
    const failure = classifyWorkersAiError(error);
    failures.push(failure);
    if (typeof env.WORKER_ID === "string") {
      console.warn(
        JSON.stringify({
          event: "ai.provider_failed",
          provider,
          error_code: failure.code,
          transient: failure.transient
        })
      );
    }
  };
  const accept = (
    raw: unknown,
    metrics: {
      inputUnits?: number;
      outputUnits?: number;
      requestId?: string;
      modelName?: string;
    } = {}
  ) => {
    const result = validateStructuredResponse(raw, schema, metrics);
    qualityCheck?.(result.data);
    return result;
  };
  if (cerebrasEnabled(env)) {
    try {
      const serializedSchema = JSON.stringify(jsonSchema);
      const responseFormat =
        serializedSchema.length <= 5_000
          ? {
              type: "json_schema",
              json_schema: { name: "aula_clara_response", strict: true, schema: jsonSchema }
            }
          : { type: "json_object" };
      const result = await withProviderTimeout(
        chatWithCerebras(env, messages, responseFormat, maxTokens),
        providerTimeoutMs
      );
      return accept(result.response, {
        ...result,
        modelName: env.CEREBRAS_GENERATION_MODEL
      });
    } catch (error) {
      rememberFailure("cerebras", error);
    }
  }
  if (groqEnabled(env)) {
    try {
      const strictSchema = model.startsWith("openai/gpt-oss");
      const result = await withProviderTimeout(
        chatWithGroq(
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
        ),
        providerTimeoutMs
      );
      return accept(result.response, { ...result, modelName: model });
    } catch (error) {
      rememberFailure("groq", error);
    }
  }
  if (geminiEnabled(env)) {
    try {
      const result = await withProviderTimeout(
        chatWithGemini(env, messages, maxTokens),
        providerTimeoutMs
      );
      return accept(result.response, { ...result, modelName: env.GEMINI_GENERATION_MODEL });
    } catch (error) {
      rememberFailure("gemini", error);
    }
  }
  try {
    const raw = await withProviderTimeout(
      Promise.resolve(env.AI.run(cloudflareFallbackModel, cloudflareRequest)),
      providerTimeoutMs
    );
    return accept(raw, {
      requestId: env.AI.aiGatewayLogId ?? undefined,
      modelName: cloudflareFallbackModel
    });
  } catch (error) {
    rememberFailure("cloudflare", error);
  }
  if (openRouterEnabled(env)) {
    try {
      const result = await withProviderTimeout(
        chatWithOpenRouter(env, messages, maxTokens),
        providerTimeoutMs
      );
      return accept(result.response, { ...result, modelName: env.OPENROUTER_GENERATION_MODEL });
    } catch (error) {
      rememberFailure("openrouter", error);
    }
  }
  const schemaFailure = failures.find((failure) =>
    [
      "invalid_provider_json",
      "invalid_provider_schema",
      "groq_request_too_large",
      "groq_invalid_request",
      "material_quality_insufficient",
      "material_source_mismatch",
      "material_timestamp_mismatch"
    ].includes(failure.code)
  );
  if (schemaFailure) throw schemaFailure;
  const nextRetry = failures
    .slice(1)
    .reduce(earliestRetry, failures[0] ?? classifyWorkersAiError(null));
  const failureCodes = failures
    .map((failure) => failure.code)
    .filter((code, index, items) => items.indexOf(code) === index)
    .join("+")
    .slice(0, 180);
  throw new JobProcessingError(
    `all_text_providers_failed:${failureCodes || "unknown"}`,
    "Todos os provedores de IA disponíveis foram consultados. O sistema continuará alternando automaticamente até concluir.",
    true,
    Math.max(15, Math.min(nextRetry.retryDelaySeconds ?? 15, 60))
  );
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
        true,
        5
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
  if (cerebrasEnabled(env)) {
    try {
      const result = await withProviderTimeout(
        chatWithCerebras(env, messages, undefined, 3000),
        8_000
      );
      return {
        ...validate(result.response, result),
        modelName: env.CEREBRAS_GENERATION_MODEL
      };
    } catch (error) {
      failures.push(classifyWorkersAiError(error));
    }
  }
  if (groqEnabled(env)) {
    try {
      const result = await withProviderTimeout(
        chatWithGroq(env, model, messages, undefined, 3000),
        8_000
      );
      return validate(result.response, result);
    } catch (error) {
      failures.push(classifyWorkersAiError(error));
    }
  }
  if (geminiEnabled(env)) {
    try {
      const result = await withProviderTimeout(chatWithGemini(env, messages, 3000), 8_000);
      return validate(result.response, result);
    } catch (error) {
      failures.push(classifyWorkersAiError(error));
    }
  }
  try {
    const raw = await withProviderTimeout(
      Promise.resolve(
        env.AI.run(env.CLOUDFLARE_REVIEW_MODEL, {
          messages,
          temperature: 0.1,
          max_tokens: 3000
        })
      ),
      8_000
    );
    return validate(raw, { requestId: env.AI.aiGatewayLogId ?? undefined });
  } catch (error) {
    failures.push(classifyWorkersAiError(error));
  }
  if (openRouterEnabled(env)) {
    try {
      const result = await withProviderTimeout(chatWithOpenRouter(env, messages, 3000), 8_000);
      return validate(result.response, result);
    } catch (error) {
      failures.push(classifyWorkersAiError(error));
    }
  }
  // A revisão global ainda fará uma segunda leitura. Um único trecho problemático
  // não pode manter a aula inteira presa em um ciclo sem progresso.
  return {
    data: {
      segments: [
        {
          segment_id: segment.segment_id,
          revised_text: segment.raw_text,
          confidence: 0.5
        }
      ]
    },
    modelName: "original-preserved-after-provider-failover"
  };
}

function splitLongReviewText(text: string, maximumCharacters = 1200): string[] {
  const remaining = text.trim();
  if (remaining.length <= maximumCharacters) return [remaining];
  const pieces: string[] = [];
  let cursor = remaining;
  while (cursor.length > maximumCharacters) {
    const window = cursor.slice(0, maximumCharacters + 1);
    const sentenceBreak = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("? "),
      window.lastIndexOf("! ")
    );
    const wordBreak = window.lastIndexOf(" ");
    const cut = sentenceBreak >= maximumCharacters * 0.55 ? sentenceBreak + 1 : wordBreak;
    const safeCut = cut > 0 ? cut : maximumCharacters;
    pieces.push(cursor.slice(0, safeCut).trim());
    cursor = cursor.slice(safeCut).trim();
  }
  if (cursor) pieces.push(cursor);
  return pieces.filter(Boolean);
}

async function reviewLongSegmentAsPlainText(
  env: CloudflareEnv,
  segment: {
    segment_id: string;
    raw_text: string;
    start_ms: number;
    end_ms: number;
  },
  context: string,
  model: string
) {
  const pieces = splitLongReviewText(segment.raw_text);
  const results = [];
  for (const rawText of pieces) {
    results.push(
      await reviewSingleAsPlainText(
        env,
        { ...segment, raw_text: rawText },
        context.slice(0, 1000),
        model
      )
    );
  }
  return {
    data: {
      segments: [
        {
          segment_id: segment.segment_id,
          revised_text: results
            .map((result) => result.data.segments[0]?.revised_text ?? "")
            .filter(Boolean)
            .join(" "),
          confidence: Math.min(
            ...results.map((result) => result.data.segments[0]?.confidence ?? 0.5)
          )
        }
      ]
    },
    modelName: results.every(
      (result) => result.modelName === "original-preserved-after-provider-failover"
    )
      ? "original-preserved-after-provider-failover"
      : model,
    inputUnits: results.reduce((total, result) => total + (result.inputUnits ?? 0), 0),
    outputUnits: results.reduce((total, result) => total + (result.outputUnits ?? 0), 0),
    requestId: undefined
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
  context: string,
  model = activeReviewModel(env)
) {
  let result: Awaited<ReturnType<typeof runStructured<z.infer<typeof indexedReviewBatchSchema>>>>;
  try {
    result = await runStructured(
      env,
      model,
      indexedReviewBatchSchema,
      `${REVIEW_RULES} Leia os segmentos como partes consecutivas da mesma aula. Corrija erros de reconhecimento, pontuação, concordância e frases quebradas para produzir uma transcrição clara, coerente e fácil de entender. Preserve exatamente todos os índices recebidos, uma única vez e na mesma ordem. Entregue uma versão final utilizável; não crie pendências nem peça confirmação. Não use HTML.`,
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
      6000,
      env.CLOUDFLARE_REVIEW_MODEL,
      8_000
    );
  } catch (error) {
    const recoverableReviewError =
      error instanceof JobProcessingError &&
      [
        "invalid_provider_json",
        "invalid_provider_schema",
        "groq_request_too_large",
        "groq_invalid_request"
      ].includes(error.code);
    if (recoverableReviewError && segments.length === 1) {
      return reviewLongSegmentAsPlainText(env, segments[0]!, context, model);
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
    env.CLOUDFLARE_GENERATION_MODEL,
    20_000
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

type MaterialTranscriptSegment = {
  segment_id: string;
  start_ms: number;
  end_ms: number;
  speaker_label: string | null;
  text: string;
};

function splitMaterialTranscript(
  transcript: ReadonlyArray<MaterialTranscriptSegment>,
  maximumCharacters = 8_000
): MaterialTranscriptSegment[][] {
  const chunks: MaterialTranscriptSegment[][] = [];
  let current: MaterialTranscriptSegment[] = [];
  let currentCharacters = 0;
  for (const segment of transcript) {
    const characters = segment.text.length + 120;
    if (current.length && currentCharacters + characters > maximumCharacters) {
      chunks.push(current);
      current = [];
      currentCharacters = 0;
    }
    current.push(segment);
    currentCharacters += characters;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function normalizedStudyText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function uniqueByText<T>(items: T[], value: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = normalizedStudyText(value(item));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeMermaidLabel(value: string): string {
  return value
    .replace(/[<>()[\]{}:;#"`]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 100);
}

function mermaidFromMindmap(root: MindmapNodeContent): string {
  const lines = [`mindmap`, `  root((${safeMermaidLabel(root.label) || "Aula"}))`];
  const visit = (node: MindmapNodeContent, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${safeMermaidLabel(node.label) || "Tópico"}`);
    node.children.forEach((child) => visit(child, depth + 1));
  };
  root.children.forEach((child) => visit(child, 2));
  return lines.join("\n");
}

function combineMaterialParts(
  materialType: GeneratableMaterial,
  parts: unknown[],
  classTitle: string
): unknown {
  if (materialType === "summary") {
    const summaries = parts.map((part) => summaryContentSchema.parse(part));
    return {
      overview: summaries.map((item) => item.overview).join("\n\n"),
      concepts: uniqueByText(
        summaries.flatMap((item) => item.concepts),
        (item) => item
      ),
      mechanisms: uniqueByText(
        summaries.flatMap((item) => item.mechanisms),
        (item) => item
      ),
      classifications: uniqueByText(
        summaries.flatMap((item) => item.classifications),
        (item) => item
      ),
      cause_and_effect: uniqueByText(
        summaries.flatMap((item) => item.cause_and_effect),
        (item) => item
      ),
      teacher_examples: uniqueByText(
        summaries.flatMap((item) => item.teacher_examples),
        (item) => item
      ),
      emphasized_points: uniqueByText(
        summaries.flatMap((item) => item.emphasized_points),
        (item) => item
      ),
      traps: uniqueByText(
        summaries.flatMap((item) => item.traps),
        (item) => item
      ),
      exam_items: uniqueByText(
        summaries.flatMap((item) => item.exam_items),
        (item) => item
      ),
      references: summaries.flatMap((item) => item.references)
    };
  }
  if (materialType === "notes") {
    const notes = parts.map((part) => notesContentSchema.parse(part));
    const sections = uniqueByText(
      notes.flatMap((item) => item.sections),
      (item) => `${item.title} ${item.body.slice(0, 160)}`
    ).sort((left, right) => left.timestamp_ms - right.timestamp_ms);
    return {
      title: notes[0]?.title || `Apostila — ${classTitle}`,
      chronological_index: sections.map((section) => section.title),
      sections,
      teacher_examples: uniqueByText(
        notes.flatMap((item) => item.teacher_examples),
        (item) => item
      ),
      emphasized_points: uniqueByText(
        notes.flatMap((item) => item.emphasized_points),
        (item) => item
      ),
      remaining_questions: uniqueByText(
        notes.flatMap((item) => item.remaining_questions),
        (item) => item
      )
    };
  }
  if (materialType === "flashcards") {
    const cards = uniqueByText(
      parts.flatMap((part) => flashcardsContentSchema.parse(part).flashcards),
      (item) => item.front
    ).map((card, index) => ({ ...card, id: `fc_${index + 1}` }));
    return { flashcards: cards };
  }
  if (materialType === "questions") {
    const questions = uniqueByText(
      parts.flatMap((part) => questionsContentSchema.parse(part).questions),
      (item) => item.question
    ).map((question, index) => ({ ...question, id: `q_${index + 1}` }));
    return { questions };
  }
  const maps = parts.map((part) => mindmapContentSchema.parse(part));
  const root = {
    id: "root",
    label: classTitle || maps[0]?.title || "Aula",
    children: maps.flatMap((map, partIndex) =>
      map.root.children.map((child, childIndex) => ({
        ...child,
        id: `topic_${partIndex + 1}_${childIndex + 1}`
      }))
    )
  };
  return {
    title: `Mapa mental — ${classTitle}`,
    root,
    mermaid: mermaidFromMindmap(root)
  };
}

function rejectLowQuality(message: string): never {
  throw new JobProcessingError("material_quality_insufficient", message, true, 1);
}

function assertMaterialQuality(
  materialType: GeneratableMaterial,
  content: unknown,
  transcriptCharacters: number,
  maximumTimestampMs: number
): void {
  if (materialType === "summary") {
    const summary = summaryContentSchema.parse(content);
    const details = [
      ...summary.concepts,
      ...summary.mechanisms,
      ...summary.classifications,
      ...summary.cause_and_effect,
      ...summary.teacher_examples,
      ...summary.emphasized_points,
      ...summary.traps,
      ...summary.exam_items
    ];
    const explained = details.filter((item) => item.trim().split(/\s+/u).length >= 6);
    if (
      (transcriptCharacters > 1_000 && summary.overview.length < 120) ||
      (transcriptCharacters > 2_000 && explained.length < 8) ||
      (maximumTimestampMs > 600_000 &&
        Math.max(0, ...summary.references.map((item) => item.timestamp_ms)) <
          maximumTimestampMs * 0.8)
    )
      rejectLowQuality("O resumo ficou superficial. O próximo provedor será tentado.");
    return;
  }
  if (materialType === "notes") {
    const notes = notesContentSchema.parse(content);
    const bodyCharacters = notes.sections.reduce(
      (total, section) => total + section.body.length,
      0
    );
    const minimum = Math.min(8_000, Math.max(250, Math.floor(transcriptCharacters * 0.06)));
    if (
      bodyCharacters < minimum ||
      notes.sections.some(
        (section) =>
          /conte[uú]do\s+(?:a partir|apresentado|do trecho)|por volta de\s+\d{1,2}:\d{2}/iu.test(
            section.title
          ) || section.body.trim().split(/\s+/u).length < 35
      ) ||
      (maximumTimestampMs > 600_000 &&
        Math.max(0, ...notes.sections.map((item) => item.timestamp_ms)) < maximumTimestampMs * 0.8)
    )
      rejectLowQuality("A apostila ficou incompleta. O próximo provedor será tentado.");
    return;
  }
  if (materialType === "flashcards") {
    const cards = flashcardsContentSchema.parse(content).flashcards;
    if (
      (transcriptCharacters > 2_000 && cards.length < 10) ||
      (maximumTimestampMs > 600_000 &&
        Math.max(0, ...cards.map((item) => item.timestamp_ms)) < maximumTimestampMs * 0.8) ||
      cards.some(
        (card) =>
          card.front.length < 12 ||
          card.back.length < 35 ||
          /conte[uú]do apresentado|por volta de|neste trecho|no [aá]udio/iu.test(card.front)
      )
    )
      rejectLowQuality("Os flashcards ficaram incompletos. O próximo provedor será tentado.");
    return;
  }
  if (materialType === "questions") {
    const questions = questionsContentSchema.parse(content).questions;
    if (
      (transcriptCharacters > 2_000 && questions.length < 10) ||
      (maximumTimestampMs > 600_000 &&
        Math.max(0, ...questions.map((item) => item.timestamp_ms)) < maximumTimestampMs * 0.8) ||
      questions.some(
        (question) =>
          !question.question.includes("?") ||
          question.question.length < 25 ||
          /qual alternativa corresponde|conte[uú]do apresentado|por volta de|neste trecho|no [aá]udio/iu.test(
            question.question
          ) ||
          question.correct_explanation.length < 20 ||
          Object.keys(question.incorrect_explanations).length !== 4
      )
    )
      rejectLowQuality("As questões não passaram pela validação. O próximo provedor será tentado.");
    return;
  }
  const mindmap = mindmapContentSchema.parse(content);
  const countNodes = (node: typeof mindmap.root): number =>
    1 + node.children.reduce((total, child) => total + countNodes(child), 0);
  const labels: string[] = [];
  const collectLabels = (node: typeof mindmap.root) => {
    labels.push(node.label);
    node.children.forEach(collectLabels);
  };
  collectLabels(mindmap.root);
  if (
    (transcriptCharacters > 2_000 && countNodes(mindmap.root) < 12) ||
    labels.some((label) =>
      /conte[uú]do\s+(?:a partir|apresentado)|por volta de\s+\d{1,2}:\d{2}/iu.test(label)
    )
  )
    rejectLowQuality("O mapa mental ficou superficial. O próximo provedor será tentado.");
}

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
  const transcriptCharacters = transcript.reduce(
    (total, segment) => total + segment.text.length,
    0
  );
  const allowedSegmentIds = new Set(transcript.map((segment) => segment.segment_id));
  const maximumTimestampMs = Math.max(...transcript.map((segment) => segment.end_ms));
  const specificInstructions: Record<GeneratableMaterial, string> = {
    notes:
      "Crie uma apostila completa e didática, cobrindo a aula do início ao fim. Cada seção deve explicar o conteúdo em parágrafos claros, incluindo definições, mecanismos, classificações, relações, exemplos e observações do professor. Não entregue apenas tópicos. Inclua também seções dos 20% finais do áudio.",
    summary:
      "Crie um resumo substancial para revisão, cobrindo toda a duração da aula. Em cada lista, escreva afirmações completas no formato conceito seguido de explicação; nunca devolva apenas nomes de tópicos. Inclua comentários, exemplos e ênfases principais do professor, com referências distribuídas do início aos 20% finais do áudio.",
    flashcards:
      "Crie no mínimo 10 cards e quantos mais forem necessários para cobrir o conteúdo importante, sem limite máximo artificial. Faça cards autossuficientes, aprofundados e variados, distribuídos por toda a aula, inclusive os 20% finais. Frente como pergunta objetiva e verso como resposta explicada e fiel à aula. Evite duplicações, perguntas vagas e respostas de uma palavra.",
    questions:
      "Crie no mínimo 10 questões e quantas mais forem necessárias, sem limite máximo artificial, cobrindo toda a aula inclusive os 20% finais. Eleve a dificuldade: exija compreensão, aplicação, comparação e relações de causa e consequência. Use cinco alternativas igualmente plausíveis, exatamente uma correta, sem pistas óbvias por tamanho ou linguagem. Explique por que a correta está correta e por que cada outra está incorreta. Evite duplicações e faça uma verificação interna de coerência.",
    mindmap:
      "Crie uma hierarquia profunda, clara e abrangente que represente todos os grandes assuntos, mecanismos, relações e exemplos da aula. O Mermaid é secundário; use somente mindmap, recuo com espaços e rótulos curtos sem caracteres de controle."
  };
  const transcriptParts = splitMaterialTranscript(transcript);
  const minimumItemsPerPart = Math.max(3, Math.ceil(10 / transcriptParts.length));
  const generatedParts: StructuredResult<unknown>[] = [];
  for (const [partIndex, transcriptPart] of transcriptParts.entries()) {
    const partStart = transcriptPart[0]?.start_ms ?? 0;
    const partEnd = transcriptPart.at(-1)?.end_ms ?? maximumTimestampMs;
    const partRequirement =
      materialType === "questions"
        ? `Nesta parte, crie pelo menos ${minimumItemsPerPart} questões conceituais completas. Cada enunciado precisa ter contexto próprio e terminar com uma pergunta; jamais use timestamp ou trecho transcrito como enunciado ou alternativa.`
        : materialType === "flashcards"
          ? `Nesta parte, crie pelo menos ${minimumItemsPerPart} flashcards conceituais autossuficientes. A frente deve nomear o conceito e fazer uma pergunta específica; nunca pergunte sobre "o conteúdo", "o trecho" ou o timestamp.`
          : materialType === "notes"
            ? "Transforme esta parte em capítulos didáticos com títulos temáticos reais e parágrafos explicativos. Sintetize a fala como material escrito; remova saudações, interrupções, repetições, comentários administrativos e vícios de linguagem. Não copie a transcrição como corpo e não use o horário como título."
            : materialType === "mindmap"
              ? "Extraia conceitos e relações desta parte. Use rótulos conceituais curtos, nunca frases da transcrição, timestamps ou nomes genéricos como conteúdo/tópico. Produza pelo menos três ramos temáticos quando houver conteúdo suficiente."
              : "Resuma esta parte em afirmações completas, explicando conceitos e relações sem copiar blocos da transcrição.";
    generatedParts.push(
      await runStructured(
        env,
        activeGenerationModel(env),
        schema,
        `Gere material de estudo em português usando exclusivamente a transcrição validada. Você está processando a parte ${partIndex + 1} de ${transcriptParts.length}, entre ${formatTimestamp(partStart)} e ${formatTimestamp(partEnd)}. Preserve timestamps em milissegundos e IDs de origem. Não use HTML. ${specificInstructions[materialType]} ${partRequirement}`,
        { class: classContext, transcript: transcriptPart },
        materialType === "questions" || materialType === "mindmap",
        materialType === "questions"
          ? 8_000
          : materialType === "flashcards"
            ? 6_000
            : materialType === "notes" || materialType === "summary"
              ? 7_000
              : 5_000,
        env.CLOUDFLARE_GENERATION_MODEL,
        35_000,
        (candidate) => {
          verifySourceReferences(candidate, allowedSegmentIds, maximumTimestampMs);
          const partCharacters = transcriptPart.reduce(
            (total, segment) => total + segment.text.length,
            0
          );
          if (materialType === "flashcards") {
            const cards = flashcardsContentSchema.parse(candidate).flashcards;
            if (
              cards.length < minimumItemsPerPart ||
              cards.some(
                (card) =>
                  card.front.length < 12 ||
                  card.back.length < 35 ||
                  /conte[uú]do apresentado|por volta de|neste trecho|no [aá]udio/iu.test(card.front)
              )
            )
              rejectLowQuality("Os flashcards desta parte ficaram genéricos ou incompletos.");
          } else if (materialType === "questions") {
            const questions = questionsContentSchema.parse(candidate).questions;
            if (
              questions.length < minimumItemsPerPart ||
              questions.some(
                (question) =>
                  !question.question.includes("?") ||
                  question.question.length < 25 ||
                  /qual alternativa corresponde|conte[uú]do apresentado|por volta de|neste trecho|no [aá]udio/iu.test(
                    question.question
                  ) ||
                  question.correct_explanation.length < 20
              )
            )
              rejectLowQuality("As questões desta parte ficaram genéricas ou incompletas.");
          } else {
            assertMaterialQuality(materialType, candidate, partCharacters, partEnd);
          }
        }
      )
    );
  }
  const combined = combineMaterialParts(
    materialType,
    generatedParts.map((part) => part.data),
    typeof classContext.title === "string" ? classContext.title : "Aula"
  );
  verifySourceReferences(combined, allowedSegmentIds, maximumTimestampMs);
  assertMaterialQuality(materialType, combined, transcriptCharacters, maximumTimestampMs);
  return {
    data: combined,
    modelName: `ai-composed:${[...new Set(generatedParts.map((part) => part.modelName).filter(Boolean))].join("+")}`,
    inputUnits: generatedParts.reduce((total, part) => total + (part.inputUnits ?? 0), 0),
    outputUnits: generatedParts.reduce((total, part) => total + (part.outputUnits ?? 0), 0),
    requestId: generatedParts.at(-1)?.requestId
  };
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
        `Timestamp: ${formatTimestamp(section.timestamp_ms)}`
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
