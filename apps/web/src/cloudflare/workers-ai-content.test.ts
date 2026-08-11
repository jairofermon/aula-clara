import { afterEach, describe, expect, it, vi } from "vitest";
import { JobProcessingError } from "./contracts";
import { generateWithWorkersAi, reviewWithWorkersAi } from "./workers-ai-content";
import type { MaterialGenerationPart } from "./workers-ai-content";

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
    expect(env.AI.run).toHaveBeenCalledTimes(2);
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

  it("troca de provedor na mesma execução quando o primeiro retorna JSON inválido", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          id: "groq-invalid",
          choices: [{ message: { content: "resposta sem json" } }]
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          responseId: "gemini-valid",
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      segments: [
                        {
                          index: 0,
                          revised_text: "Texto corrigido pelo segundo provedor.",
                          confidence: 0.9
                        }
                      ]
                    })
                  }
                ]
              }
            }
          ]
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      ...groqEnv(),
      GEMINI_API_KEY: "gemini_test_key_long_enough",
      GEMINI_DATA_PROCESSING_CONSENT: "accepted",
      GEMINI_GENERATION_MODEL: "gemini-2.5-flash"
    } as unknown as CloudflareEnv;

    await expect(
      reviewWithWorkersAi(
        env,
        [
          {
            segment_id: "00000000-0000-4000-8000-000000000001",
            raw_text: "texto corrigido pelo segundo provedor",
            start_ms: 0,
            end_ms: 1000
          }
        ],
        "contexto"
      )
    ).resolves.toMatchObject({
      data: {
        segments: [
          expect.objectContaining({ revised_text: "Texto corrigido pelo segundo provedor." })
        ]
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(env.AI.run).not.toHaveBeenCalled();
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
      code: expect.stringContaining("all_text_providers_failed:"),
      transient: true,
      retryDelaySeconds: 60
    });
  });

  it("não declara sucesso quando nenhum provedor revisa o trecho", async () => {
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
    ).rejects.toMatchObject({
      code: expect.stringContaining("all_text_providers_failed:"),
      transient: true
    });
  });

  it("divide progressivamente um lote estruturalmente inválido até revisar cada segmento", async () => {
    const env = cloudflareEnv(null);
    const segments = Array.from({ length: 4 }, (_, index) => ({
      segment_id: `00000000-0000-4000-8000-${(index + 20).toString().padStart(12, "0")}`,
      raw_text: `Trecho ${index + 1} para revisão.`,
      start_ms: index * 1000,
      end_ms: (index + 1) * 1000
    }));
    vi.mocked(env.AI.run).mockImplementation(async (_model, input) => {
      const message = (input as { messages: Array<{ content: string }> }).messages.at(-1)?.content;
      const payload = JSON.parse(message ?? "{}") as {
        segments: Array<{ raw_text: string }>;
      };
      if (payload.segments.length > 1) {
        return {
          response: {
            segments: [{ index: 99, revised_text: "Resposta incompleta.", confidence: 0.8 }]
          }
        };
      }
      return {
        response: {
          segments: [
            {
              index: 0,
              revised_text: `${payload.segments[0]!.raw_text} Corrigido pela IA.`,
              confidence: 0.9
            }
          ]
        }
      };
    });

    const result = await reviewWithWorkersAi(env, segments, "contexto");

    expect(env.AI.run).toHaveBeenCalledTimes(7);
    expect(result.data.segments).toHaveLength(4);
    expect(result.data.segments.map((segment) => segment.segment_id)).toEqual(
      segments.map((segment) => segment.segment_id)
    );
    expect(
      result.data.segments.every((segment) => segment.revised_text.includes("Corrigido"))
    ).toBe(true);
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

  it("divide internamente um segmento longo que o provedor não aceita como lote", async () => {
    const env = cloudflareEnv(null);
    const original = `${"Primeira frase extensa para revisão. ".repeat(38)}${"Segunda parte da explicação. ".repeat(20)}`;
    vi.mocked(env.AI.run)
      .mockRejectedValueOnce(new JobProcessingError("groq_request_too_large", "grande", true, 5))
      .mockImplementation(async (_model, input) => {
        const message = (input as { messages: Array<{ content: string }> }).messages.at(
          -1
        )?.content;
        return { response: message?.split("Transcrição: ").at(-1) ?? "" };
      });

    const result = await reviewWithWorkersAi(
      env,
      [
        {
          segment_id: "00000000-0000-4000-8000-000000000001",
          raw_text: original,
          start_ms: 0,
          end_ms: 1000
        }
      ],
      "contexto"
    );

    expect(result.data.segments[0]?.revised_text.length).toBeGreaterThan(1200);
    expect(env.AI.run).toHaveBeenCalledTimes(3);
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

  it("divide uma aula longa e consolida capítulos produzidos por IA", async () => {
    const run = vi.fn().mockImplementation(async (_model: string, request: unknown) => {
      const messages = (request as { messages: Array<{ content: string }> }).messages;
      const payload = JSON.parse(messages[1]!.content) as {
        transcript: Array<{ segment_id: string; start_ms: number }>;
      };
      const source = payload.transcript[0]!;
      const partNumber = run.mock.calls.length;
      return {
        response: {
          title: "Apostila de Tanatologia",
          chronological_index: [`Fundamentos da parte ${partNumber}`],
          sections: [
            {
              title: `Fundamentos conceituais da parte ${partNumber}`,
              body: "A seção explica de maneira didática os conceitos centrais apresentados pelo professor, relacionando definições, mecanismos, diferenças relevantes, aplicações práticas e consequências para o raciocínio clínico. O texto organiza o conteúdo acadêmico em uma sequência coerente, elimina repetições da fala e preserva os exemplos necessários para a compreensão e para a revisão posterior do estudante. ".repeat(
                2
              ),
              timestamp_ms: source.start_ms,
              source_segment_ids: [source.segment_id]
            }
          ],
          teacher_examples: [],
          emphasized_points: [`Ponto conceitual relevante da parte ${partNumber}.`],
          remaining_questions: []
        }
      };
    });
    const env = {
      ...cloudflareEnv({}),
      AI: { run, aiGatewayLogId: null }
    } as unknown as CloudflareEnv;
    const longTranscript = Array.from({ length: 4 }, (_, index) => ({
      segment_id: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
      start_ms: index * 60_000,
      end_ms: (index + 1) * 60_000,
      speaker_label: null,
      text: `Explicação acadêmica da parte ${index + 1}. `.repeat(180)
    }));

    const result = await generateWithWorkersAi(env, "notes", longTranscript, {
      title: "Tanatologia"
    });

    expect(run).toHaveBeenCalledTimes(4);
    expect(result.data).toMatchObject({
      chronological_index: [
        "Fundamentos conceituais da parte 1",
        "Fundamentos conceituais da parte 2",
        "Fundamentos conceituais da parte 3",
        "Fundamentos conceituais da parte 4"
      ]
    });
    expect(result.modelName).toBe("ai-composed:@cf/meta/llama-3.1-8b-instruct-fast");
  });

  it("gera uma parte por execução, reutiliza o checkpoint e conclui sem repetir IA", async () => {
    const run = vi.fn().mockImplementation(async (_model: string, request: unknown) => {
      const messages = (request as { messages: Array<{ content: string }> }).messages;
      const payload = JSON.parse(messages[1]!.content) as {
        transcript: Array<{ segment_id: string; start_ms: number }>;
      };
      const source = payload.transcript[0]!;
      const partNumber = run.mock.calls.length;
      return {
        response: {
          title: "Apostila com retomada",
          chronological_index: [`Parte ${partNumber}`],
          sections: [
            {
              title: `Conceitos da parte ${partNumber}`,
              body: "Este capítulo apresenta os conceitos centrais da aula de modo didático, relacionando definições, mecanismos, consequências e aplicações. A explicação preserva o conteúdo acadêmico relevante, remove repetições da fala e organiza o raciocínio para permitir compreensão e revisão eficiente pelo estudante. ".repeat(
                3
              ),
              timestamp_ms: source.start_ms,
              source_segment_ids: [source.segment_id]
            }
          ],
          teacher_examples: [],
          emphasized_points: [`Ênfase da parte ${partNumber}.`],
          remaining_questions: []
        }
      };
    });
    const env = {
      ...cloudflareEnv({}),
      AI: { run, aiGatewayLogId: null }
    } as unknown as CloudflareEnv;
    const twoPartTranscript = Array.from({ length: 2 }, (_, index) => ({
      segment_id: `00000000-0000-4000-8000-${(index + 40).toString().padStart(12, "0")}`,
      start_ms: index * 60_000,
      end_ms: (index + 1) * 60_000,
      speaker_label: null,
      text: `Conteúdo acadêmico detalhado da parte ${index + 1}. `.repeat(180)
    }));
    let checkpoint: MaterialGenerationPart[] = [];

    const first = await generateWithWorkersAi(
      env,
      "notes",
      twoPartTranscript,
      { title: "Aula" },
      {
        maxNewParts: 1,
        onCheckpoint: async (parts) => {
          checkpoint = parts;
        }
      }
    );

    expect(first).toMatchObject({ completed: false, partsCompleted: 1, partsTotal: 2 });
    expect(checkpoint).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);

    const second = await generateWithWorkersAi(
      env,
      "notes",
      twoPartTranscript,
      { title: "Aula" },
      {
        completedParts: checkpoint,
        maxNewParts: 1,
        onCheckpoint: async (parts) => {
          checkpoint = parts;
        }
      }
    );

    expect(second.completed).toBe(true);
    expect(checkpoint).toHaveLength(2);
    expect(run).toHaveBeenCalledTimes(2);
    if (second.completed) {
      expect(second.data).toMatchObject({
        chronological_index: ["Conceitos da parte 1", "Conceitos da parte 2"]
      });
    }
  });
});
