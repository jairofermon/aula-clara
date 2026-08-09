import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeWhisperResponse } from "./contracts";
import { transcribeWithDeepgram } from "./deepgram-provider";

const env = {
  DEEPGRAM_API_KEY: "deepgram_test_key_long_enough",
  DEEPGRAM_TRANSCRIPTION_MODEL: "nova-3"
} as unknown as CloudflareEnv;

afterEach(() => vi.unstubAllGlobals());

describe("Deepgram transcription provider", () => {
  it("preserva tempos, confiança e diarização das utterances", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          metadata: { request_id: "deepgram-request-1" },
          results: {
            utterances: [
              {
                transcript: "Aula iniciada.",
                start: 1.25,
                end: 3.6,
                confidence: 0.97,
                speaker: 0
              }
            ]
          }
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await transcribeWithDeepgram(
      env,
      new Uint8Array([1, 2, 3]).buffer,
      "aula.mp3",
      "pt"
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("model=nova-3");
    expect(String(url)).toContain("language=pt");
    expect(String(url)).toContain("diarize_model=latest");
    expect(init.headers).toMatchObject({ authorization: "Token deepgram_test_key_long_enough" });
    expect(normalizeWhisperResponse(result.data, 5_000)).toEqual([
      {
        text: "Aula iniciada.",
        start_ms: 1250,
        end_ms: 3600,
        speaker_label: "Speaker 1",
        confidence: 0.97
      }
    ]);
    expect(result.requestId).toBe("deepgram-request-1");
  });

  it("usa palavras como fallback quando utterances não estão presentes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: {
              channels: [
                {
                  alternatives: [
                    {
                      words: [
                        {
                          word: "primeira",
                          punctuated_word: "Primeira",
                          start: 0,
                          end: 0.4,
                          confidence: 0.9,
                          speaker: 0
                        },
                        {
                          word: "frase",
                          punctuated_word: "frase.",
                          start: 0.4,
                          end: 1,
                          confidence: 0.8,
                          speaker: 0
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          }),
          { status: 200 }
        )
      )
    );

    const result = await transcribeWithDeepgram(env, new ArrayBuffer(1), "aula.wav", "pt");

    expect(result.data.segments).toEqual([
      {
        text: "Primeira frase.",
        start: 0,
        end: 1,
        speaker: "Speaker 1",
        confidence: 0.8500000000000001
      }
    ]);
  });
});
