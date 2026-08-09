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

interface StructuredResult<T> {
  data: T;
  inputUnits?: number;
  outputUnits?: number;
  requestId?: string;
}

function classifyWorkersAiError(error: unknown): JobProcessingError {
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
  jsonObjectMode = false
): Promise<StructuredResult<T>> {
  let raw: unknown;
  try {
    const jsonSchema = z.toJSONSchema(schema);
    raw = await env.AI.run(model, {
      messages: [
        {
          role: "system",
          content: jsonObjectMode
            ? `${system} Responda somente com um objeto JSON válido que satisfaça rigorosamente este JSON Schema: ${JSON.stringify(jsonSchema)}`
            : system
        },
        { role: "user", content: JSON.stringify(payload) }
      ],
      response_format: jsonObjectMode
        ? { type: "json_object" }
        : { type: "json_schema", json_schema: jsonSchema },
      temperature: 0.1,
      max_tokens: 6000
    });
  } catch (error) {
    throw classifyWorkersAiError(error);
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
    inputUnits: envelope.success ? envelope.data.usage?.prompt_tokens : undefined,
    outputUnits: envelope.success ? envelope.data.usage?.completion_tokens : undefined,
    requestId: env.AI.aiGatewayLogId ?? undefined
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
  try {
    raw = await env.AI.run(env.CLOUDFLARE_REVIEW_MODEL, {
      messages: [
        {
          role: "system",
          content: `${REVIEW_RULES} Retorne somente o texto final corrigido, sem JSON, título, explicação, aspas ou Markdown.`
        },
        {
          role: "user",
          content: `Contexto: ${context.slice(0, 3000)}\n\nTranscrição: ${segment.raw_text}`
        }
      ],
      temperature: 0.1,
      max_tokens: 3000
    });
  } catch (error) {
    throw classifyWorkersAiError(error);
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

  return {
    data: {
      segments: [
        {
          segment_id: segment.segment_id,
          revised_text: usable ? revised : segment.raw_text,
          confidence: usable ? 0.75 : 0.5
        }
      ]
    },
    inputUnits: envelope.success ? envelope.data.usage?.prompt_tokens : undefined,
    outputUnits: envelope.success ? envelope.data.usage?.completion_tokens : undefined,
    requestId: env.AI.aiGatewayLogId ?? undefined
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
      env.CLOUDFLARE_REVIEW_MODEL,
      indexedReviewBatchSchema,
      `${REVIEW_RULES} Preserve exatamente todos os índices recebidos, uma única vez e na mesma ordem. Entregue uma versão final utilizável; não crie pendências nem peça confirmação. Não use HTML.`,
      {
        segments: segments.map((segment, index) => ({
          index,
          raw_text: segment.raw_text,
          start_ms: segment.start_ms,
          end_ms: segment.end_ms
        })),
        context: context.slice(0, 8000)
      }
    );
  } catch (error) {
    const recoverableFormatError =
      error instanceof JobProcessingError &&
      ["invalid_provider_json", "invalid_provider_schema"].includes(error.code);
    if (recoverableFormatError && segments.length === 1) {
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
    env.CLOUDFLARE_GENERATION_MODEL,
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
