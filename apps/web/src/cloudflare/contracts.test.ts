import { describe, expect, it } from "vitest";
import { normalizeWhisperResponse } from "./contracts";

describe("resposta Whisper do Workers AI", () => {
  it("converte segundos locais em milissegundos inteiros", () => {
    expect(
      normalizeWhisperResponse(
        {
          text: "Olá mundo",
          transcription_info: { language: "pt", duration: 3.456 },
          segments: [{ text: "Olá mundo", start: 1.234, end: 3.456 }]
        },
        10_000
      )
    ).toEqual([
      {
        text: "Olá mundo",
        start_ms: 1234,
        end_ms: 3456,
        speaker_label: null,
        confidence: null
      }
    ]);
  });

  it("usa o texto integral quando o provider não devolve segmentos", () => {
    expect(normalizeWhisperResponse({ text: "Aula curta" }, 5_000)[0]).toMatchObject({
      text: "Aula curta",
      start_ms: 0,
      end_ms: 5_000
    });
  });

  it("rejeita timestamps externos inválidos", () => {
    expect(() =>
      normalizeWhisperResponse({ segments: [{ text: "erro", start: 4, end: 2 }] }, 5_000)
    ).toThrow();
  });
});
