import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildNotesPdf } from "./client-pdf";

describe("PDF da apostila no navegador", () => {
  it("gera um PDF válido com capa e conteúdo", async () => {
    const bytes = await buildNotesPdf({
      classTitle: "Introdução à fisiologia",
      subjectName: "Fisiologia",
      classDate: "2026-08-02",
      transcriptVersion: 1,
      notes: {
        title: "Introdução à fisiologia",
        chronological_index: ["00:00 — Abertura"],
        sections: [
          {
            title: "Abertura",
            body: "Conceitos iniciais apresentados pelo professor.",
            timestamp_ms: 0,
            source_segment_ids: ["00000000-0000-4000-8000-000000000001"]
          }
        ],
        teacher_examples: ["Exemplo da aula"],
        emphasized_points: ["Ponto importante"],
        remaining_questions: []
      }
    });
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("%PDF");
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(document.getTitle()).toBe("Introdução à fisiologia");
  });
});
