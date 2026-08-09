import { describe, expect, it } from "vitest";
import {
  assertTranscriptQuality,
  mergeTranscriptSegments,
  normalizeWhisperResponse
} from "./contracts";

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

describe("qualidade da transcrição", () => {
  it("agrupa falas curtas sem perder o intervalo global nem misturar falantes", () => {
    expect(
      mergeTranscriptSegments([
        {
          text: "Primeira frase.",
          start_ms: 0,
          end_ms: 4_000,
          speaker_label: "A",
          confidence: 0.9
        },
        {
          text: "Segunda frase.",
          start_ms: 4_200,
          end_ms: 9_000,
          speaker_label: "A",
          confidence: 0.8
        },
        {
          text: "Outro falante.",
          start_ms: 9_100,
          end_ms: 12_000,
          speaker_label: "B",
          confidence: 0.95
        }
      ])
    ).toEqual([
      {
        text: "Primeira frase. Segunda frase.",
        start_ms: 0,
        end_ms: 9_000,
        speaker_label: "A",
        confidence: 0.85
      },
      {
        text: "Outro falante.",
        start_ms: 9_100,
        end_ms: 12_000,
        speaker_label: "B",
        confidence: 0.95
      }
    ]);
  });
  it("rejeita transcrição longa que termina muito antes do áudio", () => {
    expect(() =>
      assertTranscriptQuality(
        [
          {
            text: "conteúdo válido ".repeat(100),
            start_ms: 0,
            end_ms: 300_000,
            speaker_label: null,
            confidence: null
          }
        ],
        1_200_000
      )
    ).toThrow(/incompleta ou repetitiva/i);
  });

  it("rejeita três segmentos consecutivos repetidos", () => {
    const text = "este trecho foi repetido indevidamente pelo modelo";
    expect(() =>
      assertTranscriptQuality(
        [
          { text, start_ms: 0, end_ms: 300_000, speaker_label: null, confidence: null },
          { text, start_ms: 300_000, end_ms: 600_000, speaker_label: null, confidence: null },
          { text, start_ms: 600_000, end_ms: 900_000, speaker_label: null, confidence: null },
          {
            text: "encerramento ".repeat(100),
            start_ms: 900_000,
            end_ms: 1_200_000,
            speaker_label: null,
            confidence: null
          }
        ],
        1_200_000
      )
    ).toThrow(/incompleta ou repetitiva/i);
  });

  it("aceita conteúdo suficiente que cobre a duração total", () => {
    expect(() =>
      assertTranscriptQuality(
        Array.from({ length: 12 }, (_, index) => ({
          text: `Trecho ${index} ${"conteúdo explicado com detalhes ".repeat(7)}`,
          start_ms: index * 100_000,
          end_ms: (index + 1) * 100_000,
          speaker_label: null,
          confidence: 0.9
        })),
        1_200_000
      )
    ).not.toThrow();
  });
});
