import { describe, expect, it } from "vitest";
import { flashcardsToAnkiCsv, formatTimestamp, questionSchema, uploadStartSchema } from "../src";

describe("formatTimestamp", () => {
  it("formata minutos e horas", () => {
    expect(formatTimestamp(65_999)).toBe("01:05");
    expect(formatTimestamp(3_661_000)).toBe("01:01:01");
    expect(formatTimestamp(-1)).toBe("00:00");
  });
});

describe("schemas", () => {
  it("rejeita hash e MIME ausentes", () => {
    expect(uploadStartSchema.safeParse({}).success).toBe(false);
  });

  it("exige exatamente uma alternativa correta existente", () => {
    const parsed = questionSchema.safeParse({
      id: "q1",
      question: "Pergunta?",
      alternatives: ["a", "b", "c", "d", "e"].map((id) => ({ id, text: id })),
      correct_alternative_id: "x",
      correct_explanation: "Porque sim",
      incorrect_explanations: {},
      difficulty: "easy",
      timestamp_ms: 0,
      source_segment_ids: ["0f01c490-f3fd-49a7-af85-93d466fc8c21"]
    });
    expect(parsed.success).toBe(false);
  });
});

describe("flashcardsToAnkiCsv", () => {
  it("escapa ponto e vírgula, aspas e linhas", () => {
    const csv = flashcardsToAnkiCsv([
      {
        id: "1",
        front: "O que é; aula?",
        back: 'Uma "explicação"\nclara',
        timestamp_ms: 1000,
        tags: ["teste"],
        difficulty: "easy",
        source_segment_ids: ["0f01c490-f3fd-49a7-af85-93d466fc8c21"]
      }
    ]);
    expect(csv).toContain('"O que é; aula?"');
    expect(csv).toContain('"Uma ""explicação""<br>clara"');
  });
});
