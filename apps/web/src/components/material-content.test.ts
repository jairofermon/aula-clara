import { describe, expect, it } from "vitest";
import { materialToText } from "./material-content";

describe("exportação legível de materiais", () => {
  it("formata timestamps da apostila em hora, minuto e segundo", () => {
    const text = materialToText("notes", {
      title: "Apostila",
      chronological_index: ["Introdução"],
      sections: [
        {
          title: "Rigor mortis",
          body: "Explicação completa.",
          timestamp_ms: 3_661_000,
          source_segment_ids: ["00000000-0000-4000-8000-000000000001"]
        }
      ],
      teacher_examples: [],
      emphasized_points: [],
      remaining_questions: []
    });
    expect(text).toContain("[01:01:01]");
    expect(text).not.toContain("3661000 ms");
  });

  it("exporta perguntas e respostas dos flashcards sem JSON", () => {
    const text = materialToText("flashcards", {
      flashcards: [
        {
          id: "card-1",
          front: "O que é tanatologia?",
          back: "Estudo dos fenômenos da morte.",
          timestamp_ms: 77_000,
          tags: ["tanatologia"],
          difficulty: "medium",
          source_segment_ids: ["00000000-0000-4000-8000-000000000001"]
        }
      ]
    });
    expect(text).toContain("Pergunta: O que é tanatologia?");
    expect(text).toContain("Resposta: Estudo dos fenômenos da morte.");
    expect(text).not.toContain('"flashcards"');
  });
});
