import { afterEach, describe, expect, it, vi } from "vitest";
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

function groqEnv(): CloudflareEnv {
  return {
    AI: { run: vi.fn(), aiGatewayLogId: null },
    GROQ_API_KEY: "gsk_test_key_long_enough",
    GROQ_REVIEW_MODEL: "openai/gpt-oss-20b",
    GROQ_GENERATION_MODEL: "groq/compound",
    CLOUDFLARE_REVIEW_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
    CLOUDFLARE_GENERATION_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast"
  } as unknown as CloudflareEnv;
}

afterEach(() => vi.unstubAllGlobals());

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
  it("reduz uma recusa do Groq a revisão em texto simples", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("solicitação recusada", { status: 400 }))
      .mockResolvedValueOnce(
        Response.json({
          id: "request-2",
          choices: [{ message: { content: "Texto final corrigido." } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reviewWithWorkersAi(
        groqEnv(),
        [
          {
            segment_id: "00000000-0000-4000-8000-000000000001",
            raw_text: "Texto final corrigido",
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("usa o provedor alternativo quando o Groq recusa também o trecho isolado", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("solicitação recusada", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = groqEnv();
    vi.mocked(env.AI.run).mockResolvedValue({ response: "Texto claro e corrigido pela IA." });

    await expect(
      reviewWithWorkersAi(
        env,
        [
          {
            segment_id: "00000000-0000-4000-8000-000000000001",
            raw_text: "texto claro e corrigido pela ia",
            start_ms: 0,
            end_ms: 1000
          }
        ],
        "contexto"
      )
    ).resolves.toMatchObject({
      data: {
        segments: [
          {
            segment_id: "00000000-0000-4000-8000-000000000001",
            revised_text: "Texto claro e corrigido pela IA.",
            confidence: 0.75
          }
        ]
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("usa o provedor alternativo quando a cota temporária do Groq é atingida", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("limite temporário", { status: 429 }))
    );
    const env = groqEnv();
    vi.mocked(env.AI.run).mockResolvedValue({
      response: {
        segments: [{ index: 0, revised_text: "Texto corrigido sem interrupção.", confidence: 0.9 }]
      }
    });

    await expect(
      reviewWithWorkersAi(
        env,
        [
          {
            segment_id: "00000000-0000-4000-8000-000000000001",
            raw_text: "texto corrigido sem interrupção",
            start_ms: 0,
            end_ms: 1000
          }
        ],
        "contexto"
      )
    ).resolves.toMatchObject({
      data: {
        segments: [expect.objectContaining({ revised_text: "Texto corrigido sem interrupção." })]
      }
    });
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("aguarda a janela gratuita que renovar primeiro quando os dois provedores esgotam", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("limite temporário", { status: 429 }))
    );
    const env = groqEnv();
    vi.mocked(env.AI.run).mockRejectedValue(new Error("3036 daily free allocation exceeded"));

    await expect(
      reviewWithWorkersAi(
        env,
        [
          {
            segment_id: "00000000-0000-4000-8000-000000000001",
            raw_text: "texto aguardando revisão",
            start_ms: 0,
            end_ms: 1000
          }
        ],
        "contexto"
      )
    ).rejects.toMatchObject({
      code: "groq_free_rate_limit",
      transient: true,
      retryDelaySeconds: 3600
    });
  });

  it("não marca texto bruto como revisado quando nenhum provedor entrega correção válida", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("solicitação recusada", { status: 400 }))
    );
    const env = groqEnv();
    vi.mocked(env.AI.run).mockResolvedValue({ response: "" });

    await expect(
      reviewWithWorkersAi(
        env,
        [
          {
            segment_id: "00000000-0000-4000-8000-000000000001",
            raw_text: "texto ainda não revisado",
            start_ms: 0,
            end_ms: 1000
          }
        ],
        "contexto"
      )
    ).rejects.toMatchObject({ code: "invalid_provider_schema", transient: true });
  });

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
