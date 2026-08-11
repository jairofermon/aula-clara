import { describe, expect, it } from "vitest";
import {
  chatgptImportSchema,
  type ChatgptImport,
  type TranscriptSegment
} from "@aula-clara/shared";
import {
  buildChatgptPackage,
  buildSafeMindmapMermaid,
  validateChatgptReferences
} from "./chatgpt-package";

const segmentId = "11111111-1111-4111-8111-111111111111";
const segment: TranscriptSegment = {
  id: segmentId,
  sequence_number: 0,
  start_ms: 0,
  end_ms: 60_000,
  speaker_label: null,
  raw_text: "Texto bruto da aula.",
  revised_text: null,
  confidence: null,
  review_status: "unreviewed",
  user_confirmed: false
};

function validImport(): ChatgptImport {
  const alternatives = ["a", "b", "c", "d", "e"].map((id) => ({ id, text: `Alternativa ${id}` }));
  return chatgptImportSchema.parse({
    format: "aula-clara-result",
    format_version: 1,
    class_id: "22222222-2222-4222-8222-222222222222",
    transcript_version: 1,
    model_name: "gpt-5.6-sol",
    reasoning_effort: "xhigh",
    transcript: {
      segments: [{ segment_id: segmentId, revised_text: "Texto revisado.", confidence: 0.95 }]
    },
    materials: {
      notes: {
        title: "Apostila",
        chronological_index: ["Introdução"],
        sections: [
          { title: "Tema", body: "Conteúdo", timestamp_ms: 0, source_segment_ids: [segmentId] }
        ],
        teacher_examples: [],
        emphasized_points: [],
        remaining_questions: []
      },
      summary: {
        overview: "Visão geral",
        concepts: ["Conceito"],
        mechanisms: [],
        classifications: [],
        cause_and_effect: [],
        teacher_examples: [],
        emphasized_points: [],
        traps: [],
        exam_items: [],
        references: [{ timestamp_ms: 0, source_segment_ids: [segmentId] }]
      },
      flashcards: {
        flashcards: Array.from({ length: 10 }, (_, index) => ({
          id: `fc-${index}`,
          front: `Frente ${index}`,
          back: `Verso ${index}`,
          timestamp_ms: 0,
          tags: ["tema"],
          difficulty: "medium",
          source_segment_ids: [segmentId]
        }))
      },
      questions: {
        questions: Array.from({ length: 10 }, (_, index) => ({
          id: `q-${index}`,
          question: `Questão ${index}`,
          alternatives,
          correct_alternative_id: "a",
          correct_explanation: "A está correta.",
          incorrect_explanations: {
            b: "B incorreta",
            c: "C incorreta",
            d: "D incorreta",
            e: "E incorreta"
          },
          difficulty: "hard",
          timestamp_ms: 0,
          source_segment_ids: [segmentId]
        }))
      },
      mindmap: { title: "Mapa", root: { id: "root", label: "Tema (central)", children: [] } }
    }
  });
}

describe("pacote manual do ChatGPT", () => {
  it("exporta somente o texto bruto e inclui instruções de cobertura", () => {
    const result = buildChatgptPackage({
      classMetadata: {
        id: "22222222-2222-4222-8222-222222222222",
        transcript_version: 1,
        subject_name: "Medicina",
        title: "Aula",
        topic: "Tema",
        teacher_name: null,
        class_date: "2026-08-10",
        language: "pt",
        notes: "",
        glossary: ""
      },
      files: [{ original_name: "slides.pdf", file_type: "slides", mime_type: "application/pdf" }],
      segments: [{ ...segment, revised_text: "Não deve ser exportado" }]
    });
    expect(result.transcript.segments[0]).toMatchObject({
      segment_id: segmentId,
      raw_text: segment.raw_text
    });
    expect(result.transcript.segments[0]).not.toHaveProperty("revised_text");
    expect(result.instructions).toContain("todos devem aparecer exatamente uma vez");
    expect(result.instructions).toContain('disposition "discard"');
  });

  it("aceita fala descartável sem perder o segmento nem o timestamp", () => {
    const result = validImport();
    result.transcript.segments[0] = {
      segment_id: segmentId,
      revised_text: "",
      confidence: 0.99,
      disposition: "discard"
    };

    expect(chatgptImportSchema.safeParse(result).success).toBe(true);
    expect(validateChatgptReferences(result, [segment])).toEqual([]);
  });

  it("aceita resultado anterior com fala descartável vazia e sem disposition", () => {
    const result = validImport();
    result.transcript.segments[0] = {
      segment_id: segmentId,
      revised_text: "",
      confidence: 0.99
    };

    expect(chatgptImportSchema.safeParse(result).success).toBe(true);
  });

  it("rejeita segmento marcado para manter quando o texto está vazio", () => {
    const result = validImport();
    result.transcript.segments[0] = {
      segment_id: segmentId,
      revised_text: "",
      confidence: 0.99,
      disposition: "keep"
    };

    expect(chatgptImportSchema.safeParse(result).success).toBe(false);
  });

  it("aceita um resultado completo e rejeita referências de outra aula", () => {
    const result = validImport();
    expect(validateChatgptReferences(result, [segment])).toEqual([]);
    result.materials.flashcards.flashcards[0]!.source_segment_ids = [
      "33333333-3333-4333-8333-333333333333"
    ];
    expect(validateChatgptReferences(result, [segment])).toContain(
      "Um material referencia um segmento que não pertence a esta aula."
    );
  });

  it("gera Mermaid local sem construções fornecidas pelo modelo", () => {
    const result = buildSafeMindmapMermaid({
      id: "root",
      label: "Tema <script> (central)",
      children: []
    });
    expect(result).toBe("mindmap\n  Tema script central");
  });
});
