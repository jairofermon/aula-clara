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

describe("conteúdo estruturado do Workers AI", () => {
  it("rejeita revisão que troca o ID do segmento", async () => {
    const env = cloudflareEnv({
      response: {
        segments: [
          {
            segment_id: "00000000-0000-4000-8000-000000000099",
            revised_text: "Texto revisado.",
            needs_review: false,
            confidence: 0.9,
            issues: []
          }
        ]
      }
    });
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
    ).rejects.toMatchObject({ code: "review_segment_ids_mismatch" });
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
});
