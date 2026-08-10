import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeWithGemini } from "./gemini-provider";
import { generateWithWorkersAi } from "./workers-ai-content";
import type { JobProcessingError } from "./contracts";

afterEach(() => vi.unstubAllGlobals());

const segmentId = "00000000-0000-4000-8000-000000000001";

describe("roteamento entre provedores gratuitos", () => {
  it("prioriza Cerebras para geração estruturada", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: "cerebras-summary",
        choices: [
          {
            message: {
              content: JSON.stringify({
                overview: "Visão geral gerada pelo Cerebras",
                concepts: ["Conceito explicado de forma completa para orientar a revisão."],
                mechanisms: [],
                classifications: [],
                cause_and_effect: [],
                teacher_examples: [],
                emphasized_points: [],
                traps: [],
                exam_items: [],
                references: [{ timestamp_ms: 0, source_segment_ids: [segmentId] }]
              })
            }
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      AI: { run: vi.fn(), aiGatewayLogId: null },
      CEREBRAS_API_KEY: "csk_test_key_long_enough",
      CEREBRAS_GENERATION_MODEL: "gpt-oss-120b",
      GROQ_API_KEY: "gsk_test_key_long_enough",
      GROQ_GENERATION_MODEL: "groq/compound",
      CLOUDFLARE_GENERATION_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
      GEMINI_DATA_PROCESSING_CONSENT: "disabled",
      OPENROUTER_DATA_PROCESSING_CONSENT: "disabled"
    } as unknown as CloudflareEnv;

    await expect(
      generateWithWorkersAi(
        env,
        "summary",
        [{ segment_id: segmentId, start_ms: 0, end_ms: 1000, speaker_label: null, text: "Texto" }],
        { title: "Aula" }
      )
    ).resolves.toMatchObject({
      data: { overview: "Visão geral gerada pelo Cerebras" },
      modelName: "ai-composed:gpt-oss-120b"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("agenda um novo ciclo somente depois de consultar todos os provedores disponíveis", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("busy", { status: 429 })));
    const env = {
      AI: {
        run: vi.fn().mockRejectedValue(new Error("3036 daily free allocation")),
        aiGatewayLogId: null
      },
      GROQ_API_KEY: "gsk_test_key_long_enough",
      GROQ_GENERATION_MODEL: "groq/compound",
      CLOUDFLARE_GENERATION_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
      GEMINI_DATA_PROCESSING_CONSENT: "disabled",
      OPENROUTER_DATA_PROCESSING_CONSENT: "disabled"
    } as unknown as CloudflareEnv;

    await expect(
      generateWithWorkersAi(
        env,
        "summary",
        [{ segment_id: segmentId, start_ms: 0, end_ms: 1000, speaker_label: null, text: "Texto" }],
        { title: "Aula" }
      )
    ).rejects.toMatchObject({
      code: expect.stringContaining("all_text_providers_failed:"),
      transient: true,
      retryDelaySeconds: expect.any(Number)
    } satisfies Partial<JobProcessingError>);
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });
  it("usa Gemini para áudio e preserva segmentos temporais válidos", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          responseId: "gemini-audio-1",
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      segments: [{ start: 0, end: 1.5, text: "Olá, turma." }]
                    })
                  }
                ]
              }
            }
          ]
        })
      )
    );
    const result = await transcribeWithGemini(
      {
        GEMINI_API_KEY: "gemini_test_key_long_enough",
        GEMINI_DATA_PROCESSING_CONSENT: "accepted",
        GEMINI_GENERATION_MODEL: "gemini-2.5-flash"
      } as unknown as CloudflareEnv,
      new Uint8Array([1, 2, 3]).buffer,
      "aula.mp3",
      "pt",
      "Biologia"
    );
    expect(result.data.segments[0]).toMatchObject({ start: 0, end: 1.5, text: "Olá, turma." });
  });

  it("chega ao OpenRouter quando Groq, Cloudflare e Gemini estão indisponíveis", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(
        Response.json({
          id: "openrouter-1",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  overview: "Visão geral",
                  concepts: ["Conceito"],
                  mechanisms: [],
                  classifications: [],
                  cause_and_effect: [],
                  teacher_examples: [],
                  emphasized_points: [],
                  traps: [],
                  exam_items: [],
                  references: [{ timestamp_ms: 0, source_segment_ids: [segmentId] }]
                })
              }
            }
          ]
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      AI: {
        run: vi.fn().mockRejectedValue(new Error("3036 daily free allocation")),
        aiGatewayLogId: null
      },
      GROQ_API_KEY: "gsk_test_key_long_enough",
      GROQ_GENERATION_MODEL: "groq/compound",
      CLOUDFLARE_GENERATION_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
      GEMINI_DATA_PROCESSING_CONSENT: "disabled",
      OPENROUTER_API_KEY: "openrouter_test_key_long_enough",
      OPENROUTER_DATA_PROCESSING_CONSENT: "accepted",
      OPENROUTER_GENERATION_MODEL: "openrouter/free"
    } as unknown as CloudflareEnv;

    await expect(
      generateWithWorkersAi(
        env,
        "summary",
        [{ segment_id: segmentId, start_ms: 0, end_ms: 1000, speaker_label: null, text: "Texto" }],
        { title: "Aula" }
      )
    ).resolves.toMatchObject({ data: { overview: "Visão geral" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejeita resposta superficial e usa a próxima opção do ranking", async () => {
    const superficial = {
      overview: "Aula",
      concepts: ["Conceito"],
      mechanisms: [],
      classifications: [],
      cause_and_effect: [],
      teacher_examples: [],
      emphasized_points: [],
      traps: [],
      exam_items: [],
      references: [{ timestamp_ms: 0, source_segment_ids: [segmentId] }]
    };
    const detailedItems = [
      "O conceito central é explicado com contexto suficiente para orientar a revisão.",
      "O mecanismo relaciona as etapas apresentadas pelo professor durante a aula.",
      "A classificação organiza os casos conforme os critérios explicados na transcrição.",
      "A relação causal conecta o evento inicial às consequências discutidas em aula.",
      "O ponto de prova destaca uma distinção que precisa ser lembrada pelo estudante.",
      "O exemplo do professor demonstra como aplicar o conteúdo em uma situação concreta.",
      "A comparação evidencia diferenças relevantes entre conceitos próximos apresentados.",
      "A conclusão integra os principais argumentos desenvolvidos até o fim da aula."
    ];
    const accepted = {
      ...superficial,
      overview:
        "Esta visão geral apresenta de forma clara e detalhada os fundamentos discutidos pelo professor, preservando o contexto, as relações e os exemplos necessários para uma revisão confiável da aula.",
      concepts: detailedItems,
      exam_items: [detailedItems[4]]
    };
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: "groq-superficial",
        choices: [{ message: { content: JSON.stringify(superficial) } }]
      })
    );
    const cloudflareRun = vi.fn().mockResolvedValue({ response: accepted });
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      AI: { run: cloudflareRun, aiGatewayLogId: null },
      GROQ_API_KEY: "gsk_test_key_long_enough",
      GROQ_GENERATION_MODEL: "groq/compound",
      CLOUDFLARE_GENERATION_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
      GEMINI_DATA_PROCESSING_CONSENT: "disabled",
      OPENROUTER_DATA_PROCESSING_CONSENT: "disabled"
    } as unknown as CloudflareEnv;

    const result = await generateWithWorkersAi(
      env,
      "summary",
      [
        {
          segment_id: segmentId,
          start_ms: 0,
          end_ms: 60_000,
          speaker_label: null,
          text: "conteúdo detalhado da aula ".repeat(120)
        }
      ],
      { title: "Aula" }
    );

    expect(result.data).toMatchObject({ overview: accepted.overview });
    expect(result.modelName).toBe("ai-composed:@cf/meta/llama-3.1-8b-instruct-fast");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cloudflareRun).toHaveBeenCalledTimes(1);
  });
});
