import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeWhisperResponse } from "./contracts";
import { transcribeWithAssemblyAi } from "./assemblyai-provider";

const env = {
  ASSEMBLYAI_API_KEY: "assemblyai_test_key_long_enough",
  ASSEMBLYAI_TRANSCRIPTION_MODEL: "universal-3-pro"
} as unknown as CloudflareEnv;

afterEach(() => vi.unstubAllGlobals());

describe("AssemblyAI transcription provider", () => {
  it("envia, persiste o id externo e preserva tempos, confiança e falante", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ upload_url: "https://cdn.assemblyai.com/upload/audio" }), {
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "transcript-1", status: "queued" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "transcript-1",
            status: "completed",
            utterances: [
              { text: "Aula iniciada.", start: 1250, end: 3600, confidence: 0.96, speaker: "A" }
            ]
          }),
          { status: 200, headers: { "x-request-id": "request-1" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const onSubmitted = vi.fn();

    const result = await transcribeWithAssemblyAi(
      env,
      new Uint8Array([1, 2, 3]).buffer,
      "pt",
      "Farmacologia",
      { onSubmitted, pollIntervalMs: 0 }
    );

    expect(onSubmitted).toHaveBeenCalledWith("transcript-1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "assemblyai_test_key_long_enough"
    });
    expect(result).toMatchObject({ model: "universal-3-pro", requestId: "request-1" });
    expect(normalizeWhisperResponse(result.data, 5_000)).toEqual([
      {
        text: "Aula iniciada.",
        start_ms: 1250,
        end_ms: 3600,
        speaker_label: "A",
        confidence: 0.96
      }
    ]);
  });

  it("retoma um id já submetido sem reenviar o áudio", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "transcript-existing",
          status: "completed",
          utterances: [{ text: "Retomado.", start: 0, end: 1000, speaker: null }]
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await transcribeWithAssemblyAi(env, new ArrayBuffer(0), "pt", "", {
      existingTranscriptId: "transcript-existing",
      pollIntervalMs: 0
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.assemblyai.com/v2/transcript/transcript-existing"
    );
  });
});
