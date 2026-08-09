import { afterEach, describe, expect, it, vi } from "vitest";
import { chatWithGroq, transcribeWithGroq } from "./groq-provider";

const env = {
  GROQ_API_KEY: "gsk_test_key_long_enough",
  GROQ_TRANSCRIPTION_MODEL: "whisper-large-v3"
} as unknown as CloudflareEnv;

afterEach(() => vi.unstubAllGlobals());

describe("provedor Groq gratuito", () => {
  it("envia áudio com timestamps sem expor a chave no payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          text: "Aula",
          segments: [{ text: "Aula", start: 0, end: 1 }]
        }),
        { status: 200, headers: { "x-request-id": "req-1" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await transcribeWithGroq(
      env,
      new Uint8Array([1, 2]).buffer,
      "aula.mp3",
      "pt",
      "Biologia"
    );

    expect(result).toMatchObject({ model: "whisper-large-v3", requestId: "req-1" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer gsk_test_key_long_enough"
    );
    const form = init.body as FormData;
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("language")).toBe("pt");
  });

  it("respeita o retry-after quando a janela gratuita está cheia", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": "90" } }))
    );

    await expect(chatWithGroq(env, "openai/gpt-oss-20b", [], undefined, 100)).rejects.toMatchObject(
      { code: "groq_free_rate_limit", retryDelaySeconds: 90 }
    );
  });
});
