import { describe, expect, it } from "vitest";
import { CHATGPT_STUDY_PROMPT } from "./transcript-handoff-panel";

describe("entrega simplificada da transcrição", () => {
  it("inclui todas as exigências do prompt de estudo", () => {
    expect(CHATGPT_STUDY_PROMPT).toContain("no mínimo 10");
    expect(CHATGPT_STUDY_PROMPT).toContain("de A até E");
    expect(CHATGPT_STUDY_PROMPT).toContain("gabarito comentado");
    expect(CHATGPT_STUDY_PROMPT).toContain("Apostila completa");
    expect(CHATGPT_STUDY_PROMPT).toContain("Flashcards");
    expect(CHATGPT_STUDY_PROMPT).toContain("Mapa mental");
    expect(CHATGPT_STUDY_PROMPT).toContain("Resumo explicativo");
    expect(CHATGPT_STUDY_PROMPT).toContain("timestamps");
  });
});
