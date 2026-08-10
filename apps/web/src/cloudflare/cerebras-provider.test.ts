import { afterEach, describe, expect, it, vi } from "vitest";
import { cerebrasEnabled, chatWithCerebras } from "./cerebras-provider";

const env = {
  CEREBRAS_API_KEY: "csk_test_key_long_enough",
  CEREBRAS_GENERATION_MODEL: "gpt-oss-120b"
} as unknown as CloudflareEnv;

afterEach(() => vi.unstubAllGlobals());

describe("Cerebras", () => {
  it("envia schema estrito e devolve uso da resposta", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: "cerebras-request-1",
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 20, completion_tokens: 5 }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatWithCerebras(
      env,
      [{ role: "user", content: "Responda" }],
      {
        type: "json_schema",
        json_schema: {
          name: "response",
          strict: true,
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false
          }
        }
      },
      500
    );

    expect(cerebrasEnabled(env)).toBe(true);
    expect(result).toMatchObject({
      response: '{"ok":true}',
      inputUnits: 20,
      outputUnits: 5,
      requestId: "cerebras-request-1"
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "gpt-oss-120b",
      max_completion_tokens: 500,
      reasoning_effort: "low",
      response_format: { type: "json_schema" }
    });
  });

  it("classifica limite gratuito como temporário e usa a janela informada", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("busy", {
          status: 429,
          headers: { "retry-after": "12" }
        })
      )
    );

    await expect(
      chatWithCerebras(env, [{ role: "user", content: "Responda" }], undefined, 500)
    ).rejects.toMatchObject({
      code: "cerebras_free_rate_limit",
      transient: true,
      retryDelaySeconds: 12
    });
  });
});
