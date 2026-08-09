import { describe, expect, it, vi } from "vitest";
import { generateWithWorkersAi, reviewWithWorkersAi } from "./workers-ai-content";

function cloudflareEnv(response: unknown): CloudflareEnv {
  return {
    AI: {
      run: vi.fn().mockResolvedValue(response),
      aiGatewayLogId: null
    },
    CLOUDFLARE_REVIEW_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
    CLOUDFLARE_GENERATION_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast"
  } as unknown as CloudflareEnv;
}

const transcript = [
  {
    segment_id: "00000000-0000-4000-8000-000000000001",
    start_ms: 0,
    end_ms: 1000,
    speaker_label: null,
    text: "A fotossíntese transforma energia luminosa em energia química."
  }
] as const;

describe("conteúdo estruturado do Workers AI", () => {
  it("recupera revisão com índice inválido usando texto simples", async () => {
    const env = cloudflareEnv(null);
    vi.mocked(env.AI.run)
      .mockResolvedValueOnce({
        response: {
          segments: [
            {
              index: 99,
              revised_text: "Texto revisado.",
              confidence: 0.9
            }
          ]
        }
      })
      .mockResolvedValueOnce({ response: "Texto final corrigido." });
    await expect(
      reviewWithWorkersAi(
        env,
        [
          {
            segment_id: "00000000-0000-4000-8000-000000000001",
            raw_text: "Texto revisado",
            start_ms: 0,
            end_ms: 1000
          }
        ],
        "contexto"
      )
    ).resolves.toMatchObject({
      data: {
        segments: [
          expect.objectContaining({
            segment_id: "00000000-0000-4000-8000-000000000001",
            revised_text: "Texto final corrigido."
          })
        ]
      }
    });
    expect(env.AI.run).toHaveBeenCalledTimes(2);
  });

  it("recupera JSON inválido usando texto simples", async () => {
    const env = cloudflareEnv(null);
    vi.mocked(env.AI.run)
      .mockResolvedValueOnce({ response: "isto não é json" })
      .mockResolvedValueOnce({ response: "A fotossíntese transforma energia luminosa." });

    await expect(
      reviewWithWorkersAi(
        env,
        [
          {
            segment_id: "00000000-0000-4000-8000-000000000001",
            raw_text: "A fotossíntese transforma energia luminosa",
            start_ms: 0,
            end_ms: 1000
          }
        ],
        "contexto"
      )
    ).resolves.toMatchObject({
      data: {
        segments: [
          expect.objectContaining({ revised_text: "A fotossíntese transforma energia luminosa." })
        ]
      }
    });
  });

  it("rejeita material que cita segmento inexistente", async () => {
    const env = cloudflareEnv({
      response: {
        overview: "Visão geral",
        concepts: ["Conceito"],
        mechanisms: [],
        classifications: [],
        cause_and_effect: [],
        teacher_examples: [],
        emphasized_points: [],
        traps: [],
        exam_items: [],
        references: [
          {
            timestamp_ms: 0,
            source_segment_ids: ["00000000-0000-4000-8000-000000000099"]
          }
        ]
      }
    });
    await expect(
      generateWithWorkersAi(
        env,
        "summary",
        [
          {
            segment_id: "00000000-0000-4000-8000-000000000001",
            start_ms: 0,
            end_ms: 1000,
            speaker_label: null,
            text: "Texto validado"
          }
        ],
        { title: "Aula" }
      )
    ).rejects.toMatchObject({ code: "material_source_mismatch" });
  });

  it("aceita JSON válido cercado por bloco de código", async () => {
    const env = cloudflareEnv({
      response: `\`\`\`json
{"overview":"Visão geral","concepts":["Fotossíntese"],"mechanisms":[],"classifications":[],"cause_and_effect":[],"teacher_examples":[],"emphasized_points":[],"traps":[],"exam_items":[],"references":[{"timestamp_ms":0,"source_segment_ids":["00000000-0000-4000-8000-000000000001"]}]}
\`\`\``
    });

    await expect(
      generateWithWorkersAi(env, "summary", transcript, { title: "Aula" })
    ).resolves.toMatchObject({ data: { overview: "Visão geral" } });
  });

  it("usa json_object nos materiais com schemas complexos", async () => {
    const env = cloudflareEnv({
      response: {
        title: "Fotossíntese",
        root: { id: "root", label: "Fotossíntese", children: [] },
        mermaid: "mindmap\n  root((Fotossíntese))"
      }
    });

    await generateWithWorkersAi(env, "mindmap", transcript, { title: "Aula" });

    expect(env.AI.run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ response_format: { type: "json_object" } })
    );
  });
});
