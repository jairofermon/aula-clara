export const PROMPT_VERSIONS = {
  review: "review-v3",
  notes: "notes-v2",
  summary: "summary-v2",
  flashcards: "flashcards-v2",
  questions: "questions-v3",
  mindmap: "mindmap-v3"
} as const;

export const REVIEW_RULES = `Produza a transcrição final corrigida, em português natural e fiel ao áudio. Preserve integralmente sentido, exemplos, ordem, timestamps e IDs. Não resuma nem introduza conhecimento externo. Corrija pontuação, repetições acidentais, erros evidentes de português e termos técnicos quando o contexto sustentar a correção. Em caso de incerteza, mantenha a formulação mais fiel em vez de inventar.`;
