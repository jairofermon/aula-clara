import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeWithGemini } from "./gemini-provider";
import { generateWithWorkersAi } from "./workers-ai-content";

afterEach(() => vi.unstubAllGlobals());

const segmentId = "00000000-0000-4000-8000-000000000001";

describe("roteamento entre provedores gratuitos", () => {
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
});
