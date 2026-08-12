import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildStudyMaterialPdf, buildTranscriptPdf } from "./client-pdf";

describe("PDF da transcrição no navegador", () => {
  it("gera um PDF válido com capa, conteúdo e timestamps", async () => {
    const bytes = await buildTranscriptPdf({
      classTitle: "Introdução à fisiologia",
      subjectName: "Fisiologia",
      classDate: "2026-08-02",
      transcriptVersion: 1,
      transcript: [
        {
          start_ms: 0,
          end_ms: 30_000,
          speaker_label: "Professor",
          text: "Conceitos iniciais apresentados pelo professor."
        }
      ]
    });
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("%PDF");
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(document.getTitle()).toBe("Introdução à fisiologia - Transcrição completa");
  });

  it("exporta um material de estudo paginado", async () => {
    const bytes = await buildStudyMaterialPdf({
      title: "Flashcards",
      classTitle: "Tanatologia Forense",
      text: "FLASHCARD 1 [00:12]\nPergunta: O que é óbito?\nResposta: Cessação irreversível das funções vitais."
    });
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("%PDF");
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(document.getTitle()).toBe("Flashcards - Tanatologia Forense");
  });
});
