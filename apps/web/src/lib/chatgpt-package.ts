import type { ChatgptImport, TranscriptSegment } from "@aula-clara/shared";

export const CHATGPT_PACKAGE_VERSION = 1 as const;
export const CHATGPT_PACKAGE_MAX_BYTES = 15 * 1024 * 1024;

type ClassMetadata = {
  id: string;
  transcript_version: number;
  subject_name: string;
  title: string;
  topic: string;
  teacher_name: string | null;
  class_date: string;
  language: string;
  notes: string;
  glossary: string;
};

type SourceFile = {
  original_name: string;
  file_type: "slides" | "supplement";
  mime_type: string;
};

export function buildChatgptInstructions(segmentCount: number) {
  return `Você é o revisor acadêmico do Aula Clara. Analise integralmente este arquivo e, se fornecidos, os PDFs de slides anexados na mesma conversa.

OBJETIVO
Transformar a transcrição bruta em material de estudo fiel, claro, completo e bem estruturado. A transcrição possui ${segmentCount} segmentos e todos devem aparecer exatamente uma vez no resultado.

REGRAS DA TRANSCRIÇÃO
1. Preserve rigorosamente cada segment_id. Não crie, remova, una, divida nem reordene segmentos.
2. Corrija pontuação, concordância, falsos inícios, repetições acidentais e erros evidentes de reconhecimento de fala.
3. Remova somente saudações, chamadas, interrupções e vícios de linguagem sem valor acadêmico. Não resuma nem suprima explicações, exemplos ou ressalvas úteis.
4. Use os slides apenas para confirmar grafia, termos e contexto. Não acrescente conteúdo dos slides como se tivesse sido falado.
5. Não introduza conhecimento externo. Se um trecho continuar incerto, preserve a interpretação mais fiel e escreva [trecho incerto] no revised_text.
6. confidence deve refletir a segurança da revisão entre 0 e 1.

MATERIAIS
- Apostila: organizada por assuntos reais, aprofundada, cronológica e com timestamps e IDs de origem.
- Resumo: explicativo, não apenas uma lista de tópicos; inclua mecanismos, relações, exemplos, ênfases, pegadinhas e pontos de prova.
- Flashcards: no mínimo 10, sem limite máximo, diversificados e com respostas substantivas.
- Questões: no mínimo 10, sem limite máximo, cinco alternativas plausíveis, exatamente uma correta e explicações individualizadas. Evite alternativas obviamente absurdas.
- Mapa mental: hierarquia conceitual real. Não produza Mermaid; o Aula Clara gerará a visualização com segurança a partir da árvore.

VALIDAÇÃO ANTES DE ENTREGAR
- Confirme que os ${segmentCount} segment_id de entrada aparecem uma única vez.
- Confirme que todo source_segment_ids pertence à entrada.
- Confirme que timestamps estão em milissegundos e dentro da duração da aula.
- Confirme o mínimo de 10 flashcards e 10 questões.
- Confirme cinco alternativas e exatamente uma correta por questão.

SAÍDA OBRIGATÓRIA
Crie um arquivo para download chamado aula-clara-resultado.json. Não devolva o JSON apenas em bloco de código. O arquivo deve ser JSON válido, sem comentários, seguindo exatamente esta estrutura:
{
  "format": "aula-clara-result",
  "format_version": 1,
  "class_id": "copiar de class.id",
  "transcript_version": 1,
  "model_name": "modelo realmente utilizado",
  "reasoning_effort": "high | xhigh | max | unknown",
  "transcript": {
    "segments": [{ "segment_id": "uuid da entrada", "revised_text": "texto", "confidence": 0.95 }]
  },
  "materials": {
    "notes": {
      "title": "Apostila: ...",
      "chronological_index": ["..."],
      "sections": [{ "title": "...", "body": "...", "timestamp_ms": 0, "source_segment_ids": ["uuid"] }],
      "teacher_examples": ["..."], "emphasized_points": ["..."], "remaining_questions": ["..."]
    },
    "summary": {
      "overview": "...", "concepts": ["..."], "mechanisms": ["..."], "classifications": ["..."],
      "cause_and_effect": ["..."], "teacher_examples": ["..."], "emphasized_points": ["..."],
      "traps": ["..."], "exam_items": ["..."],
      "references": [{ "timestamp_ms": 0, "source_segment_ids": ["uuid"] }]
    },
    "flashcards": {
      "flashcards": [{ "id": "fc-001", "front": "...", "back": "...", "timestamp_ms": 0,
        "tags": ["..."], "difficulty": "easy | medium | hard", "source_segment_ids": ["uuid"] }]
    },
    "questions": {
      "questions": [{ "id": "q-001", "question": "...",
        "alternatives": [{ "id": "a", "text": "..." }, { "id": "b", "text": "..." },
          { "id": "c", "text": "..." }, { "id": "d", "text": "..." }, { "id": "e", "text": "..." }],
        "correct_alternative_id": "a", "correct_explanation": "...",
        "incorrect_explanations": { "b": "...", "c": "...", "d": "...", "e": "..." },
        "difficulty": "easy | medium | hard", "timestamp_ms": 0, "source_segment_ids": ["uuid"] }]
    },
    "mindmap": {
      "title": "...",
      "root": { "id": "root", "label": "...", "children": [{ "id": "n1", "label": "...", "children": [] }] }
    }
  }
}`;
}

export function buildChatgptPackage(input: {
  classMetadata: ClassMetadata;
  files: SourceFile[];
  segments: TranscriptSegment[];
}) {
  return {
    format: "aula-clara-input",
    format_version: CHATGPT_PACKAGE_VERSION,
    created_at: new Date().toISOString(),
    instructions: buildChatgptInstructions(input.segments.length),
    usage: {
      step_1: "Anexe este JSON ao ChatGPT ou Codex.",
      step_2: "Anexe também os PDFs listados em source_files, quando disponíveis.",
      step_3: "Peça: execute integralmente o campo instructions e gere o arquivo solicitado.",
      step_4: "Importe aula-clara-resultado.json de volta na mesma aula."
    },
    class: input.classMetadata,
    source_files: input.files,
    transcript: {
      source: "automatic-speech-recognition",
      time_unit: "milliseconds",
      immutable_raw_text: true,
      segments: input.segments.map((segment) => ({
        segment_id: segment.id,
        sequence_number: segment.sequence_number,
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
        speaker_label: segment.speaker_label,
        raw_text: segment.raw_text
      }))
    }
  };
}

function collectSourceIds(result: ChatgptImport) {
  return [
    ...result.materials.notes.sections.flatMap((section) => section.source_segment_ids),
    ...result.materials.summary.references.flatMap((reference) => reference.source_segment_ids),
    ...result.materials.flashcards.flashcards.flatMap((card) => card.source_segment_ids),
    ...result.materials.questions.questions.flatMap((question) => question.source_segment_ids)
  ];
}

export function validateChatgptReferences(
  result: ChatgptImport,
  sourceSegments: Pick<TranscriptSegment, "id" | "start_ms" | "end_ms">[]
) {
  const errors: string[] = [];
  const allowedIds = new Set(sourceSegments.map((segment) => segment.id));
  const resultIds = result.transcript.segments.map((segment) => segment.segment_id);
  if (resultIds.length !== allowedIds.size || new Set(resultIds).size !== resultIds.length) {
    errors.push("A transcrição importada precisa conter cada segmento exatamente uma vez.");
  }
  if (
    resultIds.some((id) => !allowedIds.has(id)) ||
    [...allowedIds].some((id) => !resultIds.includes(id))
  ) {
    errors.push("A transcrição importada não corresponde aos segmentos desta aula.");
  }
  if (collectSourceIds(result).some((id) => !allowedIds.has(id))) {
    errors.push("Um material referencia um segmento que não pertence a esta aula.");
  }
  const maxTimestamp = Math.max(...sourceSegments.map((segment) => segment.end_ms), 0);
  const timestamps = [
    ...result.materials.notes.sections.map((section) => section.timestamp_ms),
    ...result.materials.summary.references.map((reference) => reference.timestamp_ms),
    ...result.materials.flashcards.flashcards.map((card) => card.timestamp_ms),
    ...result.materials.questions.questions.map((question) => question.timestamp_ms)
  ];
  if (timestamps.some((timestamp) => timestamp > maxTimestamp)) {
    errors.push("Um material possui timestamp fora da duração transcrita.");
  }
  return errors;
}

function safeMindmapLabel(value: string) {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replace(/[()[\]{}<>]/gu, "")
    .trim()
    .slice(0, 160);
}

export function buildSafeMindmapMermaid(root: ChatgptImport["materials"]["mindmap"]["root"]) {
  const lines = ["mindmap"];
  const visit = (node: typeof root, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${safeMindmapLabel(node.label) || "Tópico"}`);
    node.children.forEach((child) => visit(child, depth + 1));
  };
  visit(root, 1);
  return lines.join("\n");
}
