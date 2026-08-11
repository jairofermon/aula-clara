import { describe, expect, it } from "vitest";
import { packageClassState } from "./pdf-completion";

describe("conclusão do PDF e do pacote", () => {
  it("não conclui a aula enquanto outro material ainda está processando", () => {
    expect(
      packageClassState([
        { material_type: "pdf", status: "completed", version: 1 },
        { material_type: "summary", status: "completed", version: 1 },
        { material_type: "questions", status: "generating", version: 1 }
      ])
    ).toEqual({
      status: "generating_materials",
      progress: 98,
      current_stage: "Gerando pacote: 2 de 3 materiais prontos",
      error_message: null
    });
  });

  it("conclui a aula somente quando todos os materiais canônicos terminaram", () => {
    expect(
      packageClassState([
        { material_type: "pdf", status: "completed", version: 1 },
        { material_type: "summary", status: "completed", version: 1 }
      ])
    ).toMatchObject({ status: "completed", progress: 100, current_stage: "Pacote concluído" });
  });

  it("ignora versões antigas não canônicas e mantém falhas em retomada", () => {
    expect(
      packageClassState([
        { material_type: "pdf", status: "completed", version: 1 },
        { material_type: "summary", status: "failed", version: 1 },
        { material_type: "summary", status: "generating", version: 2 }
      ])
    ).toMatchObject({
      status: "generating_materials",
      current_stage: "Retomando pacote: 1 de 2 materiais prontos"
    });
  });
});
